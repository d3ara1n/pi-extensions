# @d3ara1n/pi-peek

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek)

Read-only session investigation for [pi](https://github.com/earendil-works/pi). A helper model retrieves and summarizes saved records; evaluation and decisions stay with the caller. It starts with a bounded outline and reads further details as needed.

The default role is `utility`. Its model must support tool calling; thinking mode is optional.

This package has no user-facing tools or commands. It initializes the shared investigation API and main-agent tracker. [`pi-peek-user`](../pi-peek-user) supplies the local overlay; [`pi-peek-agent`](../pi-peek-agent) supplies the cross-instance tool.

## Snapshot and retrieval

Each investigation captures `sessionManager.buildSessionProjection().messages` once. Pi applies the current branch's compaction and context edits; private custom entries and context-excluded shell executions are not part of the source. Request-time extension transforms, such as runtime folding, are **not** replayed. This is a snapshot of projected saved records, not a claim to reproduce the main model's exact last request.

The initial outline retains user/assistant text and context summaries, with references such as:

```text
[user id=U1]
Find the failing test output.

[assistant id=A1]
Checking the test output.

[toolcall id=T1 name="bash" status=error]
```

Tool arguments/results are stored behind their references. A tool call and its corresponding result share one record; pending calls and orphaned results remain explicit. Large dialogue bodies and older records may be abbreviated or omitted from the outline but remain searchable and readable in the fixed snapshot. The latest user request, first retained user request and most recent compaction summary receive background allowances before the recent tail is filled. A separate allowance preserves a sample of tool/thinking references even when long later prose would otherwise displace them. Selected records retain their chronological order.

The investigation model has two internal tools, never registered on the main agent:

- `search_session`: literal, case-insensitive search across admitted records, returning short excerpts, record IDs and a pagination cursor.
- `read_session`: bounded pages from up to four IDs, with `nextOffset` for continuation. Offsets are UTF-16 character offsets within each record.

Retrieval includes saved tool arguments/result text, call IDs, error status and selected display evidence such as diffs, patches and file summaries. Paths mentioned in records are not opened. Images are represented by omission markers; base64 images, provider thinking signatures and arbitrary private metadata are excluded.

Thinking is opt-in. With the default `includeThinking: false`, thinking blocks receive no IDs and are absent from **all** retrieval paths. `includeThinking: true` admits readable, non-redacted saved thinking as separate references; it cannot recover unavailable or redacted thinking.

## Investigation lifecycle

A shared incremental parser receives all model text deltas: `<peek-summary>...</peek-summary>` captures one short factual sentence without a heading or label, and `<peek-report>...</peek-report>` releases Markdown report deltas through `onToken`. Text outside the tags is ignored. Delimiters can span deltas or text blocks; an open report tag captures through the end of the response.

Tags are reserved protocol delimiters. Literal delimiter examples in report content must escape their angle brackets. The parser does not require a summary to stream a report; missing summaries are derived from the report.

When a terminal response has no report tag, the fallback uses its **last text block**, without merging earlier explanation blocks or requesting another model response. That fallback is released only after completion, with a summary derived from the report. `reportMode` records `tagged` or `fallback`. Errors never trigger fallback; output-limited terminal responses retain `stopReason: "length"` and receive a separate incomplete-report notice in the clients.

Observable stages are `investigating`, `thinking`, `searching`, `reading`, `outputting`, `retrying`, `done`, and `error`. Any model text can set `outputting`, but the character count grows only for captured report content. Untagged prose and summaries can therefore show `outputting…` with an empty report area and no character count.

A model may emit a tagged body and then request tools in the same response. That body is provisional: `onReset` clears it before retrieval continues, so it is not concatenated with the eventual terminal report. UI consumers should implement this callback; both bundled clients do.

`thinking` is reported only when the provider emits thinking events; thinking content is never part of progress or report deltas. This describes the **helper model's own reasoning** and is independent of `includeThinking`, which controls access to saved thinking in the source session. Pi-model-roles controls the helper's reasoning configuration; pi-peek does not force it off.

`onProgress` provides structured state: phase, round/maxRounds, request number, tool-call count, model, emitted report characters, and elapsed time. `onStage` remains available for simple consumers. Progress is independent of report content, so a UI can show activity while keeping the report area empty.

An investigation pins its snapshot and selected model. Sequential follow-ups retain previous questions/reports; internal retrieval exchanges are temporary. Older follow-up history may be omitted when necessary to fit the budget, with a notice to the model. One-shot `investigate()` creates a fresh snapshot and disposes it afterward. Disposal aborts pending requests and clears the in-memory snapshot/history without appending to the main session. Provider retention and the caller's own saved tool results are separate.

Usage totals include every model response in the question, including retrieval and overflow retries. `metrics` records requests started, internal search/read calls executed, and elapsed time. The final result contains the parsed `report`, `summary`, and `reportMode`.

## Budgets and limits

Input capacity comes from the resolved model's `contextWindow`, not from the main session's usage. Each model request reserves the configured output allowance, capped by the model's `maxTokens` and one eighth of its context window. The input budget is 80% of the remaining window.

The request estimator counts ASCII at approximately three characters per token and other code points at two tokens each, including serialized message metadata and internal tool schemas. This is a heuristic, **not** an exact tokenizer or a guarantee about a provider's actual limits.

- The outline is capped at 24,000 estimated tokens, with individual dialogue previews capped at 2,000. All admitted bodies remain available through retrieval.
- Reads return at most 12,000 characters combined; searches return at most 20 short matches. At most eight tool calls execute per model response.
- By default, a request allows six non-overflow model responses. The last round disables further tool calls and requests a report of the records found and any gaps. Budget pressure can do the same after reducing older exchanges or oversized tool results while preserving call/result pairing.
- Before any report text is published, a recognized provider context overflow permits at most two retries. Each retry lowers the input budget to 70% of the smaller of the previous budget and rejected request estimate. Retrieval actions are not repeated automatically. An irreducibly large question or exhausted retries produces `PeekContextOverflowError` (`code: "context_overflow"`). Once a report prefix is visible, the request is never replayed; failures preserve an explicitly incomplete report in the clients instead of appending a second answer.
- One deadline covers authentication, all model requests and retrieval rounds. Cancellation and disposal abort the active transport.

Model window metadata may differ from a provider or relay's actual limit. Retrieval reduces unnecessary input, but complex questions can require more round trips. Missing or uninspected evidence must not be reported as proof that an event never happened.

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

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — role/model resolution and provider options; load this extension alongside pi-peek.

## Configuration

```json
{
  "peek": {
    "timeoutMs": 90000,
    "role": "utility",
    "maxRounds": 6,
    "maxOutputTokens": 8192
  }
}
```

Global `~/.pi/agent/settings.json` and project `.pi/settings.json` are supported. A project `peek` block replaces the global block wholesale; missing fields use defaults. `maxRounds` is bounded to 1–20; setting it to 1 disables retrieval and requests a report from the outline. `maxOutputTokens` is a per-request allowance, subject to the model caps above. Pi-model-roles continues to control whether the selected role enables thinking.

The serving deadline defaults to 90 seconds. Cross-instance callers have their own longer transport wait timeout, configured by [`pi-peek-agent`](../pi-peek-agent#configuration).

## API

```typescript
import { getPeekAPI } from "@d3ara1n/pi-peek";

const api = getPeekAPI();
const investigation = api.createInvestigation({ includeThinking: false });
let reportText = "";
try {
  const first = await investigation.investigate("Find the failing test output.", {
    onProgress: progress => console.log(progress.stage, progress.round, progress.chars),
    onToken: text => { reportText += text; }, // refresh your Markdown view from reportText
    onReset: () => { reportText = ""; }, // retract a provisional body before further tool use
    signal,
  });
  const followUp = await investigation.investigate("Which saved output supports that?");
} finally {
  investigation.dispose();
}

const result = await api.investigate("Find the latest recorded status.");
const status = api.getMainAgentStatus();
const text = api.serializeMainConversation(); // full admitted records, not the bounded outline
```

Calls within an investigation must be sequential. `snapshotAt` identifies the fixed source. `referenceLength` is the final request's outline length in characters. Close and recreate an investigation to observe newer main-session activity.

## License

MIT
