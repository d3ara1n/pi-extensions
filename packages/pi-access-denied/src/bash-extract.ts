/**
 * Extract path candidates from unbash's AST without executing shell code.
 * PathManager applies access policy separately.
 *
 * General arguments contribute absolute, home-prefixed, and parent-traversal
 * candidates. Quoted arguments remain data, except for known cd operands.
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
  cdArguments,
  changeDirectory,
  continuing,
  directoryAssignments,
  initialDirectoryState,
  joinStates,
  unknownDirectoryState,
} from "./bash-cwd.ts";
import type { DirectoryFlow, DirectoryState } from "./bash-cwd.ts";

/** A path the command appears to reach, plus the leaf command that produced it. */
export interface ExtractedTarget {
  /** Resolved absolute path. */
  path: string;
  /** Text of the leaf command (e.g. `find / -name *.log`) that produced `path`. Absent when meaningless. */
  source?: string;
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
 * candidate. `path → source` is first-write-wins: the first leaf command that
 * surfaces a path owns its display source (later commands hitting the same path
 * add nothing — the user already sees a representative command for it).
 */
function consider(
  token: string,
  state: DirectoryState,
  source: string,
  targets: Map<string, string>,
): void {
  if (token.startsWith("-")) return; // option flag (--foo, -rf)
  if (!isEscapingCandidate(token)) return;
  if (token === "~" || token.startsWith("~/") || token === "$HOME" || token.startsWith("$HOME/")) {
    if (state.home === null) return;
    token = state.home + token.slice(token.startsWith("~") ? 1 : 5);
    if (!token) return;
  }
  // An unknown cd must not make a relative target appear to use the old cwd.
  if (
    state.cwd === null &&
    !path.isAbsolute(token) &&
    !token.startsWith("~") &&
    !token.startsWith("$HOME")
  )
    return;
  const resolved = resolveTarget(token, state.cwd ?? (path.parse(token).root || "/"));
  if (!targets.has(resolved)) targets.set(resolved, source);
}

// ── Word inspection ─────────────────────────────────────────────────────────

/**
 * Word parts that defeat static path analysis: quoted literals (data, not a
 * path) and variable expansions other than `$HOME`/`${HOME}` (unknowable at
 * parse time). Literal text, brace/glob patterns, and `$HOME` are left through.
 */
function isUnanalyzable(p: WordPart): boolean {
  switch (p.type) {
    case "SingleQuoted":
    case "DoubleQuoted":
    case "AnsiCQuoted":
    case "LocaleString":
      return true;
    case "SimpleExpansion":
      return p.text !== "$HOME";
    case "ParameterExpansion":
      return p.parameter !== "HOME";
    default:
      return false; // Literal, BraceExpansion, ExtendedGlob, ArithmeticExpansion, CommandExpansion, ProcessSubstitution
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
  targets: Map<string, string>,
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
  targets: Map<string, string>,
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
  targets: Map<string, string>,
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
  targets: Map<string, string>,
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
  targets: Map<string, string>,
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

function walkNode(
  node: Node,
  command: string,
  states: DirectoryState[],
  targets: Map<string, string>,
): DirectoryFlow {
  return mergeFlows(...states.map((state) => walkNodeAt(node, command, state, targets)));
}

function walkCommand(
  node: Command,
  command: string,
  state: DirectoryState,
  targets: Map<string, string>,
): DirectoryFlow {
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
  for (const a of node.prefix) {
    if (a.value) collectNested(a.value.parts ?? [], command, state, targets);
    if (a.array) for (const w of a.array) collectNested(w.parts ?? [], command, state, targets);
  }
  if (changed) {
    if (changed.target !== null && !targets.has(changed.target))
      targets.set(changed.target, source);
    return { success: changed.success, failure: states };
  }
  if (!node.name) return both([directoryAssignments(node, state)]);
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
  // Directory-stack operations and evaluated shell code cannot safely
  // preserve the old state, even when they eventually return a failure.
  if (["pushd", "popd", "eval", "source", "."].includes(name ?? "")) {
    return both([unknownDirectoryState(state.functions)]);
  }
  return both(states);
}

function walkNodeAt(
  node: Node,
  command: string,
  state: DirectoryState,
  targets: Map<string, string>,
): DirectoryFlow {
  const states = [state];
  switch (node.type) {
    case "Command":
      return walkCommand(node, command, state, targets);
    case "TestCommand": {
      const source = command.slice(node.pos, node.end);
      walkTestExpr(node.expression, state, source, command, targets);
      return both(states);
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
    case "Select":
      for (const w of node.wordlist)
        scanWord(w, state, command.slice(node.pos, node.end), command, targets);
      return walkLoop(node.body, undefined, command, states, targets);
    case "While":
      return walkLoop(node.body, node, command, states, targets);
    case "Case": {
      const source = command.slice(node.pos, node.end);
      scanWord(node.word, state, source, command, targets);
      let fallthrough: DirectoryState[] = [];
      let result = both(states); // The patterns might not match any branch.
      for (const item of node.items) {
        for (const p of item.pattern) scanWord(p, state, source, command, targets);
        const branch = walkScript(item.body, command, joinStates(states, fallthrough), targets);
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
      return walkLoop(node.body, undefined, command, states, targets);
    case "ArithmeticCommand":
      return both(states); // `(( … ))` — pure arithmetic, no path operands.
    case "Statement":
      return walkStatement(node, command, states, targets);
  }
}

function walkLoop(
  body: CompoundList,
  loop: Extract<Node, { type: "While" }> | undefined,
  command: string,
  states: DirectoryState[],
  targets: Map<string, string>,
): DirectoryFlow {
  const iteration = (input: DirectoryState[]): DirectoryState[] => {
    if (!loop) return continuing(walkScript(body, command, input, targets));
    const condition = walkScript(loop.clause, command, input, targets);
    const enter = loop.kind === "until" ? condition.failure : condition.success;
    const leave = loop.kind === "until" ? condition.success : condition.failure;
    return joinStates(leave, continuing(walkScript(body, command, enter, targets)));
  };
  const first = iteration(states);
  const before = new Set(states.map((state) => JSON.stringify(state)));
  if (first.some((state) => !before.has(JSON.stringify(state)))) {
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
  targets: Map<string, string>,
): DirectoryFlow {
  // Redirections are expanded before the command (and therefore before cd).
  const source = command.slice(stmt.pos, stmt.end);
  for (const state of states)
    for (const r of stmt.redirects) walkRedirect(r, state, source, command, targets);
  const flow = walkNode(stmt.command, command, states, targets);
  if (stmt.background) return { success: states, failure: [] };
  return stmt.redirects.length ? { ...flow, failure: joinStates(states, flow.failure) } : flow;
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
  const targets = new Map<string, string>(); // path → source (first-write-wins)
  let ast: Script;
  try {
    ast = parse(command);
  } catch {
    return []; // unbash is best-effort and should not throw, but guard anyway.
  }
  walkScript(ast, command, [initialDirectoryState(cwd)], targets);
  return [...targets.entries()].map(([path, source]) => ({ path, source: source || undefined }));
}

/** Path-only view of {@link extractBashTargetsDetailed} (for callers that only classify). */
export function extractBashTargets(command: string, cwd: string): string[] {
  return extractBashTargetsDetailed(command, cwd).map((t) => t.path);
}
