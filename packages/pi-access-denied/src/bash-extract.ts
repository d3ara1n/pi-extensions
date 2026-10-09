/**
 * Extract path candidates from unbash's AST without executing shell code.
 * PathManager applies access policy separately.
 *
 * General arguments contribute absolute, home-prefixed, and parent-traversal
 * candidates. Quoted literals remain data; known variable references and cd
 * operands are decoded without executing shell code.
 * Nested commands are inspected in their own shell environments.
 *
 * Each command returns directory states partitioned by success and failure.
 * Unknown directories suppress relative guesses; child shells return exit
 * status without passing directory changes back to their parent.
 *
 * Candidates retain their leaf command's source for authorization prompts.
 * Nested scripts normally share source offsets; decoded backticks can provide
 * a separate source string. Malformed input is inspected on a best-effort basis.
 */
import * as path from "node:path";
import { parse } from "unbash";
import type {
  Command,
  CompoundList,
  Node,
  Redirect,
  Script,
  Statement,
  TestExpression,
  Word,
  WordPart,
} from "unbash";
import { resolveTarget } from "./paths.ts";
import {
  assignVariable,
  cdArguments,
  changeDirectory,
  commonConditions,
  continuing,
  directoryAssignments,
  directoryStateKey,
  initialDirectoryState,
  joinStates,
  staticWord,
  unknownDirectoryState,
  unknownVariables,
} from "./bash-cwd.ts";
import type { DirectoryCondition, DirectoryFlow, DirectoryState } from "./bash-cwd.ts";

/** A path the command appears to reach, plus the leaf command that produced it. */
export interface ExtractedTarget {
  /** Resolved absolute path. */
  path: string;
  /** Text of the leaf command (e.g. `find / -name *.log`) that produced `path`. Absent when meaningless. */
  source?: string;
  /** Known cd outcomes shared by this path's detected branches; not an exhaustive execution predicate. */
  condition?: string;
}

type TargetMap = Map<string, { source: string; conditions: DirectoryCondition[] }>;

function recordTarget(targets: TargetMap, target: string, source: string, state: DirectoryState): void {
  const existing = targets.get(target);
  targets.set(target, {
    source: existing?.source ?? source,
    conditions: existing ? commonConditions(existing.conditions, state.conditions) : state.conditions,
  });
}

// ── Windows-native path detection ───────────────────────────────────────────
// A drive-letter prefix (`C:\…`, `D:/…`) uses backslash (or, under Git Bash,
// forward slash) as a path *separator*, not a shell escape. Such tokens must
// reach resolveTarget with separators intact — using the parser's dequoted
// `value` would collapse `C:\Users\me` to `C:Usersme`. Pure of platform so it
// is unit-testable anywhere.
const WIN_NATIVE_RE = /^[A-Za-z]:[\\/]/;

/** True if `token` is a Windows-native absolute path with a drive letter. */
export function isWindowsNativePath(token: string): boolean {
  return WIN_NATIVE_RE.test(token);
}

// ── Path candidate classification (pure) ────────────────────────────────────

/** Does this token look like it could escape cwd? */
function isEscapingCandidate(token: string): boolean {
  if (token.startsWith("/") || path.isAbsolute(token)) return true; // absolute (posix + windows native)
  if (token === "~" || token.startsWith("~/")) return true; // home
  if (token === "$HOME" || token.startsWith("$HOME/")) return true; // home
  if (/^~[A-Za-z_]/.test(token)) return true; // ~otheruser (another user's home, kept symbolic)
  if (token === ".." || token.startsWith("../")) return true; // parent climb
  if (/\/\.\.(\/|$)/.test(token)) return true; // embedded parent: a/.. or a/../b
  return false;
}

/** Normalize `${HOME}` → `$HOME` so the home-prefix check matches both forms. */
function normalizeHome(token: string): string {
  return token.replaceAll("${HOME}", "$HOME");
}

/**
 * Record `token` (resolved absolute) into `targets` if it is an escaping
 * candidate. The first leaf command remains the representative display source;
 * conditions are intersected across every branch and command reaching the path.
 */
function consider(
  token: string,
  state: DirectoryState,
  source: string,
  targets: TargetMap,
  expanded = false,
): void {
  if (token.startsWith("-")) return; // option flag (--foo, -rf)
  if (!isEscapingCandidate(token)) return;
  if (
    !expanded &&
    (token === "~" || token.startsWith("~/") || token === "$HOME" || token.startsWith("$HOME/"))
  ) {
    if (state.home === null) return;
    token = state.home + token.slice(token.startsWith("~") ? 1 : 5);
    if (!token) return;
  }
  // An unknown cd must not make a relative target appear to use the old cwd.
  if (
    state.cwd === null &&
    !path.isAbsolute(token) &&
    (expanded || (!token.startsWith("~") && !token.startsWith("$HOME")))
  )
    return;
  // Expansion results are literal strings: a stored "~" or "$HOME" is not
  // expanded a second time by Bash, even when the reference is unquoted.
  const resolved =
    expanded && !path.isAbsolute(token)
      ? path.resolve(state.cwd!, token)
      : resolveTarget(token, state.cwd ?? (path.parse(token).root || "/"));
  recordTarget(targets, resolved, source, state);
}

// ── Word inspection ─────────────────────────────────────────────────────────

function hasVariableReference(parts: WordPart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "SimpleExpansion" ||
      part.type === "ParameterExpansion" ||
      (part.type === "DoubleQuoted" && hasVariableReference(part.parts)),
  );
}

/** Expansions that may assign in the current shell cannot retain old values. */
function hasVariableEffects(parts: WordPart[]): boolean {
  return parts.some((part) => {
    if (part.type === "ArithmeticExpansion") return true;
    if (part.type === "DoubleQuoted" || part.type === "LocaleString")
      return hasVariableEffects(part.parts);
    if (part.type === "ParameterExpansion")
      return part.operator === "=" ||
        part.operator === ":=" ||
        part.index !== undefined ||
        hasVariableEffects(part.operand?.parts ?? []);
    return false;
  });
}

function expansionState(
  words: (Word | undefined)[],
  state: DirectoryState,
): DirectoryState {
  return words.some((word) => hasVariableEffects(word?.parts ?? []))
    ? unknownVariables(state)
    : state;
}

/** Quoted data stays opaque after variable references have been handled. */
function isUnanalyzable(p: WordPart): boolean {
  switch (p.type) {
    case "SingleQuoted":
    case "DoubleQuoted":
    case "AnsiCQuoted":
    case "LocaleString":
      return true;
    default:
      return false;
  }
}

/**
 * Recurse into a word's parts (and quoted children) for nested commands:
 * `$(cmd)`, backticks, `<(cmd)`, `>(cmd)`. These execute regardless of the
 * quoting context they appear in (even inside `"$(...)"`), so they are always
 * walked. Bare literals inside quotes (e.g. a commit-message body) are NOT
 * scanned for paths — only command boundaries recurse.
 */
function collectNested(
  parts: WordPart[] | undefined,
  command: string,
  state: DirectoryState,
  targets: TargetMap,
): void {
  if (!parts) return;
  for (const p of parts) {
    switch (p.type) {
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (p.script) walkScript(p.script, p.script.source ?? command, [state], targets);
        break;
      case "DoubleQuoted":
      case "LocaleString":
        collectNested(p.parts, command, state, targets);
        break;
      case "BraceExpansion":
      case "ExtendedGlob":
        collectNested(p.parts, command, state, targets);
        break;
      case "ParameterExpansion":
        // ${var:-$(cmd)} and ${arr[$(cmd)]} may hide nested commands.
        if (p.operand) scanWord(p.operand, state, p.text, command, targets);
        collectNested(p.indexParts, command, state, targets);
        break;
      // Literal / SimpleExpansion / AnsiCQuoted / ArithmeticExpansion: no nested commands.
    }
  }
}

/**
 * Inspect a single word for an escaping-path candidate (attributed to `source`),
 * and recurse into any nested command substitutions it contains. Shared by
 * command names, suffix args, redirect targets, and test operands.
 */
function scanWord(
  word: Word | undefined,
  state: DirectoryState,
  source: string,
  command: string,
  targets: TargetMap,
): void {
  if (!word) return;
  // `parts` is a lazy getter (NOT an own enumerable property) — access it
  // explicitly. A walker driven by Object.keys / spread / structuredClone would
  // silently see zero expansions and miss every nested command.
  const parts = word.parts ?? [];
  collectNested(parts, command, state, targets);

  // Windows-native path: backslashes are separators — use raw `text`, not the
  // dequoted `value` (which collapses `C:\Users` → `C:Users`).
  if (isWindowsNativePath(word.text)) {
    consider(word.text, state, source, targets);
    return;
  }
  if (hasVariableReference(parts)) {
    const value = staticWord(word, state, "candidate");
    if (value !== null) consider(value, state, source, targets, true);
    return;
  }
  // Quoted data literal, or unresolvable variable — not a static path. Nested
  // commands inside it were already collected above.
  if (parts.some(isUnanalyzable)) return;

  consider(normalizeHome(word.value), state, source, targets);
}

// ── AST traversal ───────────────────────────────────────────────────────────

function walkScript(
  script: Script | CompoundList,
  command: string,
  states: DirectoryState[],
  targets: TargetMap,
): DirectoryFlow {
  let flow: DirectoryFlow = { success: states, failure: [] };
  for (const stmt of script.commands) {
    const next = walkStatement(stmt, command, continuing(flow), targets);
    flow = {
      ...next,
      exitSuccess: flow.exitSuccess || next.exitSuccess,
      exitFailure: flow.exitFailure || next.exitFailure,
    };
  }
  return flow;
}

function both(states: DirectoryState[]): DirectoryFlow {
  return { success: states, failure: states };
}

function mergeFlows(...flows: DirectoryFlow[]): DirectoryFlow {
  return {
    success: joinStates(...flows.map((flow) => flow.success)),
    failure: joinStates(...flows.map((flow) => flow.failure)),
    exitSuccess: flows.some((flow) => flow.exitSuccess),
    exitFailure: flows.some((flow) => flow.exitFailure),
  };
}

function childOutcome(flow: DirectoryFlow, parent: DirectoryState[]): DirectoryFlow {
  return {
    success: flow.success.length || flow.exitSuccess ? parent : [],
    failure: flow.failure.length || flow.exitFailure ? parent : [],
  };
}

function walkRedirect(
  r: Redirect,
  state: DirectoryState,
  source: string,
  command: string,
  targets: TargetMap,
): void {
  if (r.target) scanWord(r.target, state, source, command, targets); // redirect target IS a file path
  // Heredoc body: quoted (`<<'EOF'`) is literal text the shell never executes
  // — skip. Unquoted (`<<EOF`) is parsed; its nested `$(cmd)` substitutions DO
  // execute, so recurse into `body` when the parser provides it.
  if (r.body) collectNested(r.body.parts ?? [], command, state, targets);
}

function walkTestExpr(
  e: TestExpression,
  state: DirectoryState,
  source: string,
  command: string,
  targets: TargetMap,
): void {
  switch (e.type) {
    case "TestUnary":
      scanWord(e.operand, state, source, command, targets);
      break;
    case "TestBinary":
      scanWord(e.left, state, source, command, targets);
      scanWord(e.right, state, source, command, targets);
      break;
    case "TestLogical":
      walkTestExpr(e.left, state, source, command, targets);
      walkTestExpr(e.right, state, source, command, targets);
      break;
    case "TestNot":
      walkTestExpr(e.operand, state, source, command, targets);
      break;
    case "TestGroup":
      walkTestExpr(e.expression, state, source, command, targets);
      break;
  }
}

function testWords(expression: TestExpression): Word[] {
  switch (expression.type) {
    case "TestUnary":
      return [expression.operand];
    case "TestBinary":
      return [expression.left, expression.right];
    case "TestLogical":
      return [...testWords(expression.left), ...testWords(expression.right)];
    case "TestNot":
      return testWords(expression.operand);
    case "TestGroup":
      return testWords(expression.expression);
  }
}

function walkNode(
  node: Node,
  command: string,
  states: DirectoryState[],
  targets: TargetMap,
): DirectoryFlow {
  return mergeFlows(...states.map((state) => walkNodeAt(node, command, state, targets)));
}

function walkCommand(
  node: Command,
  command: string,
  state: DirectoryState,
  targets: TargetMap,
): DirectoryFlow {
  const words = [
    node.name, ...node.suffix,
    ...node.prefix.flatMap((assignment) => [assignment.value, ...(assignment.array ?? [])]),
    ...node.redirects.flatMap((redirect) => [redirect.target, redirect.body]),
  ];
  state = expansionState(words, state);
  if (node.prefix.some((assignment) => assignment.index !== undefined))
    state = unknownVariables(state);
  const states = [state];
  // Leaf command text — verbatim slice of the original source.
  const source = command.slice(node.pos, node.end);
  scanWord(node.name, state, source, command, targets);
  const name = node.name?.value;
  const localFunction = state.functions.includes(name ?? "");
  const cdArgs = localFunction ? undefined : cdArguments(node);
  const changed = cdArgs ? changeDirectory(cdArgs, state, node) : undefined;
  for (const w of node.suffix) {
    // Resolved cd operands are recorded below, including quoted paths.
    // Unresolved operands retain the usual symbolic/glob candidates.
    if (changed && changed.target !== null) collectNested(w.parts, command, state, targets);
    else scanWord(w, state, source, command, targets);
  }
  for (const r of node.redirects) walkRedirect(r, state, source, command, targets);
  // Assignment values are data (not file access) — only recurse for nested
  // commands, never scan them as paths.
  let assigned = state;
  for (const a of node.prefix) {
    if (a.value) collectNested(a.value.parts ?? [], command, assigned, targets);
    if (a.array) for (const w of a.array) collectNested(w.parts ?? [], command, assigned, targets);
    assigned = directoryAssignments({ ...node, prefix: [a] }, assigned);
  }
  if (changed) {
    if (changed.target !== null) recordTarget(targets, changed.target, source, state);
    if (!changed.success.length) return { success: [], failure: states };
    const id = JSON.stringify([command, node.pos]);
    const withOutcome = (next: DirectoryState, outcome: DirectoryCondition["outcome"]): DirectoryState => ({
      ...next,
      conditions: [...next.conditions.filter((condition) => condition.id !== id), { id, source, outcome }],
    });
    return {
      success: changed.success.map((next) => withOutcome(next, "succeeds")),
      failure: [withOutcome(state, "fails")],
    };
  }
  if (!node.name) {
    const staticAssignments = node.prefix.every((assignment) =>
      assignment.value && staticWord(assignment.value, assigned, "assignment") !== null,
    );
    if (staticAssignments && node.redirects.length === 0)
      return { success: [assigned], failure: [] };
    return {
      success: [assigned],
      failure: node.redirects.length ? joinStates(states, [assigned]) : [assigned],
    };
  }
  if (localFunction) return both([unknownDirectoryState(state.functions)]);
  // Only an unambiguous exit terminates the list. `return` can fail outside
  // a function, and `exit` with too many arguments also leaves Bash running.
  if (
    name === "exit" &&
    node.redirects.length === 0 &&
    node.suffix.length <= 1 &&
    node.suffix.every((word) => /^[+-]?\d+$/.test(word.value))
  ) {
    const code = node.suffix.length ? Number(node.suffix[0].value) : NaN;
    return {
      success: [],
      failure: [],
      exitSuccess: !Number.isSafeInteger(code) || code % 256 === 0,
      exitFailure: !Number.isSafeInteger(code) || code % 256 !== 0,
    };
  }
  if ((name === ":" || name === "true") && node.redirects.length === 0)
    return { success: states, failure: [] };
  if (name === "false" && node.redirects.length === 0) return { success: [], failure: states };
  let invoked: string | null | undefined = name;
  let args = node.suffix;
  while (invoked === "builtin" || invoked === "command") {
    let index = 0;
    for (; index < args.length; index++) {
      const option = staticWord(args[index], state);
      if (option === null) return both([unknownDirectoryState(state.functions)]);
      if (option === "--") {
        index++;
        break;
      }
      if (!option.startsWith("-") || option === "-") break;
      if (invoked === "command" && /^-[pvV]+$/.test(option)) {
        // Query forms do not invoke the named command.
        if (/[vV]/.test(option)) return both(states);
      } else {
        return both([unknownDirectoryState(state.functions)]);
      }
    }
    invoked = args[index] ? staticWord(args[index], state) : undefined;
    args = args.slice(index + 1);
  }
  // Directory-stack operations and evaluated shell code cannot safely
  // preserve the old state, even when they eventually return a failure.
  // Unhandled cd wrappers likewise cannot keep the old cwd.
  if (
    invoked === null ||
    ["pushd", "popd", "eval", "source", ".", "cd"].includes(invoked ?? "") ||
    state.functions.includes(invoked ?? "")
  ) return both([unknownDirectoryState(state.functions)]);
  // These builtins can change scalar values or their interpretation. Their
  // options, arrays, namerefs, and input data are not evaluated here.
  const printfOption = args[0] ? staticWord(args[0], state) : "";
  const printfAssigns =
    invoked === "printf" && (printfOption === null || printfOption.startsWith("-v"));
  if (
    printfAssigns ||
    ["unset", "read", "readarray", "mapfile", "declare", "typeset",
      "local", "export", "readonly", "let", "getopts"].includes(invoked ?? "")
  ) {
    return both([unknownVariables(state)]);
  }
  if (hasVariableReference(node.name.parts ?? []) || staticWord(node.name, state) === null)
    return both([unknownDirectoryState(state.functions)]);
  return both(states);
}

function walkNodeAt(
  node: Node,
  command: string,
  state: DirectoryState,
  targets: TargetMap,
): DirectoryFlow {
  const states = [state];
  switch (node.type) {
    case "Command":
      return walkCommand(node, command, state, targets);
    case "TestCommand": {
      const source = command.slice(node.pos, node.end);
      state = expansionState(testWords(node.expression), state);
      walkTestExpr(node.expression, state, source, command, targets);
      return both([state]);
    }
    case "Pipeline": {
      if (node.commands.length === 1) {
        const flow = walkNode(node.commands[0], command, states, targets);
        return node.negated ? { ...flow, success: flow.failure, failure: flow.success } : flow;
      }
      // Bash runs pipeline stages in separate environments by default.
      let last = both(states);
      for (const c of node.commands) last = walkNode(c, command, states, targets);
      const flow = childOutcome(last, states);
      return node.negated ? { success: flow.failure, failure: flow.success } : flow;
    }
    case "AndOr": {
      let flow = walkNode(node.commands[0], command, states, targets);
      for (let i = 1; i < node.commands.length; i++) {
        if (node.operators[i - 1] === "&&") {
          const next = walkNode(node.commands[i], command, flow.success, targets);
          flow = mergeFlows({ ...flow, success: [] }, next);
        } else {
          const next = walkNode(node.commands[i], command, flow.failure, targets);
          flow = mergeFlows({ ...flow, failure: [] }, next);
        }
      }
      return flow;
    }
    case "If": {
      const condition = walkScript(node.clause, command, states, targets);
      const yes = walkScript(node.then, command, condition.success, targets);
      const no = node.else
        ? walkNode(node.else, command, condition.failure, targets)
        : { success: condition.failure, failure: [] };
      return mergeFlows(yes, no, { ...condition, success: [], failure: [] });
    }
    case "For":
    case "Select": {
      state = expansionState(node.wordlist, state);
      for (const w of node.wordlist)
        scanWord(w, state, command.slice(node.pos, node.end), command, targets);
      const flow = walkLoop(
        node.body, undefined, command,
        [assignVariable(state, node.name.value, null)], targets,
      );
      return mergeFlows({ success: [state], failure: [] }, flow);
    }
    case "While":
      return walkLoop(node.body, node, command, states, targets);
    case "Case": {
      state = expansionState([node.word, ...node.items.flatMap((item) => item.pattern)], state);
      const caseStates = [state];
      const source = command.slice(node.pos, node.end);
      scanWord(node.word, state, source, command, targets);
      let fallthrough: DirectoryState[] = [];
      let result = both(caseStates); // The patterns might not match any branch.
      for (const item of node.items) {
        for (const p of item.pattern) scanWord(p, state, source, command, targets);
        const branch = walkScript(item.body, command, joinStates(caseStates, fallthrough), targets);
        fallthrough =
          item.terminator === ";&" || item.terminator === ";;&" ? continuing(branch) : [];
        result = mergeFlows(result, branch);
      }
      return result;
    }
    case "Subshell": {
      const child = walkScript(node.body, command, states, targets);
      return childOutcome(child, states);
    }
    case "BraceGroup":
      return walkScript(node.body, command, states, targets);
    case "Function":
      walkNode(node.body, command, states, targets);
      for (const r of node.redirects)
        walkRedirect(r, state, command.slice(node.pos, node.end), command, targets);
      return {
        success: [{ ...state, functions: [...new Set([...state.functions, node.name.value])] }],
        failure: [],
      };
    case "Coproc":
      // Inspect child bodies without applying their cd to the parent.
      walkNode(node.body, command, states, targets);
      for (const r of node.redirects)
        walkRedirect(r, state, command.slice(node.pos, node.end), command, targets);
      return both(states);
    case "CompoundList":
      return walkScript(node, command, states, targets);
    case "ArithmeticFor":
      return walkLoop(node.body, undefined, command, [unknownVariables(state)], targets);
    case "ArithmeticCommand":
      return both([unknownVariables(state)]); // Arithmetic may assign shell variables.
    case "Statement":
      return walkStatement(node, command, states, targets);
  }
}

function walkLoop(
  body: CompoundList,
  loop: Extract<Node, { type: "While" }> | undefined,
  command: string,
  states: DirectoryState[],
  targets: TargetMap,
): DirectoryFlow {
  const iteration = (input: DirectoryState[]): DirectoryState[] => {
    if (!loop) return continuing(walkScript(body, command, input, targets));
    const condition = walkScript(loop.clause, command, input, targets);
    const enter = loop.kind === "until" ? condition.failure : condition.success;
    const leave = loop.kind === "until" ? condition.success : condition.failure;
    return joinStates(leave, continuing(walkScript(body, command, enter, targets)));
  };
  const first = iteration(states);
  const before = new Set(states.map(directoryStateKey));
  if (first.some((state) => !before.has(directoryStateKey(state)))) {
    // Repeated relative cd can produce unbounded directories. Widen to unknown
    // instead of reusing the first iteration's state for later executions.
    const unknown = unknownDirectoryState([
      ...new Set([...states, ...first].flatMap((state) => state.functions)),
    ]);
    iteration([unknown]);
    return both(joinStates(states, first, [unknown]));
  }
  return both(joinStates(states, first));
}

function walkStatement(
  stmt: Statement,
  command: string,
  states: DirectoryState[],
  targets: TargetMap,
): DirectoryFlow {
  const parent = states;
  states = states.map((state) =>
    expansionState(stmt.redirects.flatMap((redirect) => [redirect.target, redirect.body]), state),
  );
  // Redirections are expanded before the command (and therefore before cd).
  const source = command.slice(stmt.pos, stmt.end);
  for (const state of states)
    for (const r of stmt.redirects) walkRedirect(r, state, source, command, targets);
  let flow = walkNode(stmt.command, command, states, targets);
  if (stmt.background) return { success: parent, failure: [] };
  const isolated = stmt.command.type === "Subshell";
  if (isolated) flow = childOutcome(flow, parent);
  return stmt.redirects.length
    ? { ...flow, failure: joinStates(isolated ? parent : states, flow.failure) }
    : flow;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract escaping-looking arguments and cd destinations, each paired with
 * the leaf command (`source`) that produced it.
 *
 * Pure extraction: returns candidates without judging allow/deny (that is the
 * PathManager's job). Heuristic — see module doc for blind spots.
 */
export function extractBashTargetsDetailed(command: string, cwd: string): ExtractedTarget[] {
  const targets: TargetMap = new Map();
  let ast: Script;
  try {
    ast = parse(command);
  } catch {
    return []; // unbash is best-effort and should not throw, but guard anyway.
  }
  walkScript(ast, command, [initialDirectoryState(cwd)], targets);
  return [...targets.entries()].map(([path, { source, conditions }]) => ({
    path,
    source: source || undefined,
    ...(conditions.length ? {
      condition: "if " + conditions.map((condition) =>
        `\`${condition.source.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim()}\` ${condition.outcome}`,
      ).join(" and "),
    } : {}),
  }));
}

/** Path-only view of {@link extractBashTargetsDetailed} (for callers that only classify). */
export function extractBashTargets(command: string, cwd: string): string[] {
  return extractBashTargetsDetailed(command, cwd).map((t) => t.path);
}
