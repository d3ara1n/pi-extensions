# @d3ara1n/pi-peek

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek)

Read-only session investigation for [pi](https://github.com/earendil-works/pi): a large-context utility model digs through the session's active context — the same compaction-aware view its main assistant works from — and reports focused summaries, explanations, and details from saved tool evidence that the main assistant may not have mentioned.

**Core extension**: registers lifecycle/tracker hooks, but no tools or commands. Load it alongside [`pi-peek-user`](../pi-peek-user) for investigating your own session or [`pi-peek-agent`](../pi-peek-agent) for cross-instance investigation.

## Design

Peek sends the session's **active context view** — the last compaction summary plus everything kept after it, exactly what the main assistant currently sees — to a **large-context utility model**, then runs one streaming investigation per question. It is a read-only record view, not a retrieval agent: no internal tools, search loop, pagination, automatic compression, or application-level text/token-budget truncation. Content compacted away earlier in the session exists in the reference only as the compaction summary. Pi's projection semantics are applied the same way: content replaced or removed via context edits is sent as edited (or not at all), and shell executions excluded from context (`!` commands) are never sent.

The active context is bounded by the source session's own model window, so the peek model should have a context window at least that large, plus room for follow-up questions. A fast, inexpensive model is appropriate; no agentic search or tool use is involved.

### Included information

- User messages and assistant text
- Full saved tool-call arguments and result text, call IDs and error status
- Saved patch evidence (`diff`, `patch`, per-file changes under `files`) and truncation/full-output-path metadata
- Recorded user shell executions visible to the main model (context-excluded `!` shells are omitted)
- Compaction summaries and retained messages, branch summaries, and extension-injected context messages

Thinking is excluded by default. Callers can explicitly include readable thinking saved in the session; missing/redacted thinking and opaque signatures are never reconstructed or exposed. The source model may not save any readable thinking at all.

Images, the main system prompt, extension-private state, other branches, and external files/logs are not included. Text already missing from a saved tool result cannot be recovered. The compaction summary may overlap the retained messages that follow it.

### Follow-ups and limits

An investigation pins its captured active-context snapshot and resolved model. Each follow-up sends that same reference plus the prior questions and reports. A failed request leaves prior successful turns intact. Close and reopen to capture newer source messages.

Peek requests the model's declared output allowance rather than imposing a smaller custom cap. Provider/SDK limits still apply:

- **Output limit:** preserve the partial report and return `stopReason: "length"` separately. No automatic continuation or warning appended to the report.
- **Context limit:** surface a recognized upstream overflow as `PeekContextOverflowError` (`code: "context_overflow"`) with a diagnostic message (reference size vs. model window). Do not trim history, compress, or automatically retry. Overflow means the peek model's window is smaller than the session's active context — configure a larger-context model for the peek role.
- **Other failures:** preserve the error rather than guessing it was a context overflow. Silent provider-side truncation cannot always be detected.

The stable reference and append-only question/report history are cache-friendly. Capture time is carried with the first question, outside the large system prefix. Requests use `cacheRetention: "short"`; cache support, pricing, and retention depend on the provider.

**Read-after-burn means no local persistence by this extension.** Closing releases the reference and history; shutdown aborts active investigations. Model-provider retention is separate, and a remote caller may save the report it receives in its own session.

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-peek
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-peek"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model selection, authentication, streaming, and configured reasoning level; must be loaded as an extension

## Configuration

Optional `peek` block in global or project settings. The project block replaces the global block wholesale; omitted fields use defaults.

```json
{
  "peek": {
    "role": "utility",
    "timeoutMs": 90000
  }
}
```

`timeoutMs` is the request deadline, including authentication and streaming. It controls waiting time, not content size. Numeric values must be finite and at least 1; fractional values are floored. Legacy content-budget settings such as `recentTurns` and `toolResultLimit` are ignored.

Configure a large-context model for the selected role in pi-model-roles. Its reasoning setting controls the utility model's own generation, independently of whether saved source thinking is included.

## API

```typescript
import { getPeekAPI } from "@d3ara1n/pi-peek";

const api = getPeekAPI();

// One completion, then dispose the temporary investigation.
const result = await api.investigate("What did the final reply leave out?");

// Explicitly include readable thinking saved in the source session.
await api.investigate("Explain the recorded reasoning.", { includeThinking: true });

// User-driven follow-ups: one investigation per question, one fixed reference.
const investigation = api.createInvestigation(); // Or { includeThinking: true }.
try {
  await investigation.investigate("Summarize the authentication work.");
  const detail = await investigation.investigate("Explain the failed test.", {
    onToken: delta => { /* append report text */ },
    onStage: stage => { /* investigating / done / error */ },
  });
  // Render detail.report unchanged; show a separate notice if stopReason === "length".
} finally {
  investigation.dispose();
}
```

Calls within one investigation must be sequential. `serializeMainConversation({ includeThinking? })` returns the active-context text reference, untruncated. `getMainAgentStatus()` returns live main-agent activity, independently of the fixed investigation snapshot.

## License

MIT
