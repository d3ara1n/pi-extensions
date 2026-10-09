import * as os from "node:os";
import * as path from "node:path";
import type { Command, Word, WordPart } from "unbash";
import { resolveTarget } from "./paths.ts";

const MAX_DIRECTORY_STATES = 32;
const MAX_STATIC_WORD_LENGTH = 65_536;

/** @internal A cd outcome required by a tracked execution branch. */
export interface DirectoryCondition {
  id: string;
  source: string;
  outcome: "succeeds" | "fails";
}

/** @internal Shell-local directories and scalar values; null means not statically known. */
export interface DirectoryState {
  cwd: string | null;
  /** OLDPWD, independent of any manual assignment to PWD. */
  previous: string | null;
  home: string | null;
  /** PWD can be assigned without changing the shell's actual directory. */
  pwd: string | null;
  /** A nonempty or unknown CDPATH can redirect relative cd destinations. */
  cdpath: boolean;
  functions: string[];
  variables: Record<string, string | null>;
  /** False after IFS or unknown shell effects can change word splitting. */
  defaultIFS: boolean;
  /** Explanatory metadata; never part of shell-state identity. */
  conditions: DirectoryCondition[];
}

/** @internal Initial shell assumptions, scoped to a single tool call. */
export function initialDirectoryState(cwd: string): DirectoryState {
  return {
    cwd, previous: null, home: os.homedir(), pwd: cwd, cdpath: false,
    functions: [], variables: {}, defaultIFS: true, conditions: [],
  };
}

/** @internal Unknown shell effects must invalidate directory-related variables too. */
export function unknownDirectoryState(functions: string[] = []): DirectoryState {
  return {
    cwd: null, previous: null, home: null, pwd: null, cdpath: true,
    functions, variables: {}, defaultIFS: false, conditions: [],
  };
}

/** @internal Forget variable mutations without inventing a directory change. */
export function unknownVariables(state: DirectoryState): DirectoryState {
  return { ...unknownDirectoryState(state.functions), cwd: state.cwd, conditions: state.conditions };
}

function variableValue(name: string, state: DirectoryState): string | null {
  if (name === "HOME") return state.home;
  if (name === "PWD") return state.pwd;
  if (name === "OLDPWD") return state.previous;
  return Object.hasOwn(state.variables, name) ? state.variables[name] : null;
}

/** @internal Copy on write keeps branch and child-shell variable environments isolated. */
export function assignVariable(
  state: DirectoryState,
  name: string,
  value: string | null,
): DirectoryState {
  const next = { ...state, variables: { ...state.variables, [name]: value } };
  if (name === "HOME") next.home = value;
  if (name === "PWD") next.pwd = value;
  if (name === "OLDPWD") next.previous = value;
  if (name === "CDPATH") next.cdpath = value !== "";
  if (name === "IFS") next.defaultIFS = false;
  return next;
}

/** @internal Possible directories partitioned by the last command's exit status. */
export interface DirectoryFlow {
  success: DirectoryState[];
  failure: DirectoryState[];
  /** Terminated shell outcomes, consumed when returning to a parent shell. */
  exitSuccess?: boolean;
  exitFailure?: boolean;
}

/** @internal Compare shell values independently of authorization explanations. */
export function directoryStateKey({ conditions: _conditions, ...state }: DirectoryState): string {
  return JSON.stringify(state);
}

/** @internal Only shared conditions remain valid when execution branches merge. */
export function commonConditions(
  left: DirectoryCondition[],
  right: DirectoryCondition[],
): DirectoryCondition[] {
  return left.filter((condition) =>
    right.some((other) => other.id === condition.id && other.outcome === condition.outcome),
  );
}

/** @internal Bound branch growth without assigning an invented cwd to overflow. */
export function joinStates(...groups: DirectoryState[][]): DirectoryState[] {
  const states = new Map<string, DirectoryState>();
  for (const group of groups) {
    for (const state of group) {
      const key = directoryStateKey(state);
      const existing = states.get(key);
      if (existing) {
        states.set(key, { ...existing, conditions: commonConditions(existing.conditions, state.conditions) });
        continue;
      }
      if (states.size === MAX_DIRECTORY_STATES) {
        const functions = [...new Set(groups.flat().flatMap((item) => item.functions))];
        return [...states.values(), unknownDirectoryState(functions)];
      }
      states.set(key, state);
    }
  }
  return [...states.values()];
}

/** @internal Merge outcomes when execution continues regardless of exit status. */
export function continuing(flow: DirectoryFlow): DirectoryState[] {
  return joinStates(flow.success, flow.failure);
}

function staticParts(
  parts: WordPart[],
  state: DirectoryState,
  quoted = false,
  patterns = false,
): string | null {
  let result = "";
  for (const part of parts) {
    let value: string | null;
    switch (part.type) {
      case "Literal":
        // Unquoted glob patterns depend on the filesystem. Escaped metacharacters do not.
        if (!quoted && !patterns && /[*?[]/.test(part.text.replace(/\\./gs, ""))) return null;
        value = part.value;
        break;
      case "SingleQuoted":
      case "AnsiCQuoted":
        value = part.value;
        break;
      case "DoubleQuoted":
        value = staticParts(part.parts, state, true);
        break;
      case "SimpleExpansion":
      case "ParameterExpansion": {
        if (part.type === "ParameterExpansion" && part.text !== `\${${part.parameter}}`)
          return null;
        const name = part.type === "SimpleExpansion" ? part.text.slice(1) : part.parameter;
        value = variableValue(name, state);
        // Unquoted expansions can split into multiple arguments or expand globs.
        if (
          !quoted &&
          value !== null &&
          (/[\s*?[]/.test(value) || !state.defaultIFS)
        )
          return null;
        break;
      }
      default:
        return null;
    }
    if (value === null || result.length + value.length > MAX_STATIC_WORD_LENGTH) return null;
    result += value;
  }
  return result;
}

/** @internal Decode a scalar word without executing shell expansions. */
export function staticWord(
  word: Word,
  state: DirectoryState,
  context: "argument" | "assignment" | "candidate" = "argument",
): string | null {
  // Preserve the existing Git Bash handling of native Windows separators.
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(word.text)) return word.text;
  const parts = word.parts ?? [{ type: "Literal", text: word.text, value: word.value }];
  let value = staticParts(parts, state, context === "assignment", context === "candidate");
  if (value === null) return null;
  if (word.text === "~" || word.text.startsWith("~/")) {
    if (state.home === null) return null;
    value = state.home + value.slice(1);
  } else if (word.text.startsWith("~")) return null; // Named users and directory-stack expansions.
  return value;
}

/** @internal Recognize direct cd and its builtin/command wrappers, without treating command -v as execution. */
export function cdArguments(node: Command): Word[] | undefined {
  const name = node.name?.value;
  if (name === "cd") return node.suffix;
  if ((name === "builtin" || name === "command") && node.suffix[0]?.value === "cd")
    return node.suffix.slice(1);
  return undefined;
}

/** @internal Follow plain scalar assignments in shell evaluation order. */
export function directoryAssignments(node: Command, state: DirectoryState): DirectoryState {
  let next = state;
  for (const assignment of node.prefix) {
    if (!assignment.name) continue;
    const value =
      assignment.value && !assignment.append && !assignment.array && assignment.index === undefined
        ? staticWord(assignment.value, next, "assignment")
        : null;
    next = assignVariable(next, assignment.name, value);
  }
  return next;
}

/** @internal A failed cd preserves both directories; a successful dynamic cd makes cwd unknown. */
export function changeDirectory(
  args: Word[],
  state: DirectoryState,
  node: Command,
): {
  target: string | null;
  success: DirectoryState[];
} {
  const effective = directoryAssignments(node, state);
  const unknownSuccess = () => ({
    target: null,
    success: [{ ...state, cwd: null, pwd: null, previous: state.pwd }],
  });
  // An entirely empty unquoted expansion removes the argument. Explicit
  // quotes preserve it, so `cd $empty` uses HOME while `cd "$empty"` fails.
  args = args.filter((word) =>
    staticWord(word, state) !== "" ||
    (word.parts ?? []).some((part) =>
      part.type === "SingleQuoted" || part.type === "DoubleQuoted" ||
      part.type === "AnsiCQuoted" || part.type === "LocaleString",
    ),
  );
  let physical = false;
  let index = 0;
  for (; index < args.length; index++) {
    const option = staticWord(args[index], state);
    if (option === "--") {
      index++;
      break;
    }
    if (option === null) return unknownSuccess();
    if (!option.startsWith("-") || option === "-") break;
    // -e and -@ are platform/version dependent; keep their effects unknown.
    if (/^-[LPe@]+$/.test(option) && /[e@]/.test(option)) return unknownSuccess();
    if (!/^-[LP]+$/.test(option)) return { target: null, success: [] };
    physical = option.at(-1) === "P";
  }
  if (args.length - index > 1) return { target: null, success: [] };
  const argument = args[index];
  // Explicit operands expand before temporary prefix assignments take effect;
  // cd's implicit HOME/OLDPWD/CDPATH lookup uses the builtin's environment.
  let value = argument ? staticWord(argument, state) : effective.home;
  if (value === "-") value = effective.previous;
  if (value === "") return { target: null, success: [] };
  let target: string | null;
  if (value === null) target = null;
  // Literal quoted ~/$HOME must not be expanded again by resolveTarget.
  else if (path.isAbsolute(value))
    target = resolveTarget(value, state.cwd ?? path.parse(value).root);
  else if (
    effective.cdpath &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("./") &&
    !value.startsWith("../")
  )
    target = null;
  else target = state.cwd === null ? null : path.resolve(state.cwd, value);
  const cwd = physical ? null : target;
  return { target, success: [{ ...state, cwd, pwd: cwd, previous: state.pwd }] };
}
