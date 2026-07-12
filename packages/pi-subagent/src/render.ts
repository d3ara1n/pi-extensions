/**
 * TUI rendering for the delegate tool: the call row (`delegate <role>`) and the
 * result view (collapsed and expanded), plus the render-side elapsed-time timer.
 */

import {
  getMarkdownTheme,
  type ThemeColor,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentDetails } from "./types.ts";

// Contextual types derived from ToolDefinition so we don't depend on
// non-root-exported render types (ToolRenderContext is internal).
type RenderCallFn = NonNullable<ToolDefinition["renderCall"]>;
type RenderResultFn = NonNullable<ToolDefinition["renderResult"]>;
import {
  buildDisplayItems,
  formatUsageStats,
  elapsedSeconds,
  formatToolCall,
  statusStyle,
  formatThinking,
  renderDisplayItems,
  isFailedResult,
} from "./utils.ts";

// ── Elapsed-time animation (render-side timer) ───────────────

/**
 * Per-row render state slot holding the elapsed-time animation timer.
 * The handle lives in context.state so it is scoped to one tool row.
 */
interface DelegateRenderState {
  elapsedTimer?: ReturnType<typeof setInterval>;
}

/**
 * While a delegate is running, force a TUI repaint every second so the
 * elapsed time ticks up even when the child process is idle. Uses
 * context.invalidate() (pi's official re-render hook) rather than pushing
 * data via onUpdate — the render recomputes elapsed time fresh from Date.now().
 */
function ensureElapsedTimer(context: {
  state: Record<string, unknown>;
  invalidate?: () => void;
}): void {
  const state = context.state as DelegateRenderState;
  if (state.elapsedTimer) return;
  if (typeof context.invalidate !== "function") return;
  state.elapsedTimer = setInterval(() => {
    try {
      context.invalidate?.();
    } catch {
      /* ignore — invalidate must never break rendering */
    }
  }, 1000);
}

/** Stop the elapsed-time animation once the run reaches a terminal state. */
function clearElapsedTimer(context: { state: Record<string, unknown> }): void {
  const state = context.state as DelegateRenderState;
  if (!state.elapsedTimer) return;
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = undefined;
}

// ── renderCall: what the user sees when the tool is invoked ─────

export const renderDelegateCall: RenderCallFn = (args, theme, _context) => {
  const roleName = (args as any).role || "...";
  const text = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", roleName);
  return new Text(text, 0, 0);
};

// ── renderResult: TUI display when the tool finishes ────────

export const renderDelegateResult: RenderResultFn = (result, { expanded }, theme, context) => {
  const details = result.details as SubagentDetails | undefined;
  const isRunning = !!details?.results[0] && details.results[0].exitCode === -1;

  // Tick elapsed time every second while running; stop once terminal.
  // Placed BEFORE the empty-results early return so every terminal path
  // (abort, model-resolution failure, catch) still clears the timer —
  // otherwise the interval leaks a permanent 1 Hz re-render per aborted run.
  // The timer calls context.invalidate() so the render recomputes elapsed
  // time fresh from Date.now() without dirtying the data layer.
  if (isRunning) {
    ensureElapsedTimer(context);
  } else {
    clearElapsedTimer(context);
  }

  if (!details || details.results.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const r = details.results[0];
  const isError = !isRunning && isFailedResult(r);
  const isTimeout = !isRunning && r.stopReason === "timeout";
  const isBudget = !isRunning && r.stopReason === "budget_exceeded";
  const isFailedState = isError || isTimeout || isBudget;

  // Status icon. ⏳ running / ⏸ queued (pause) / ⏱ timeout / ⏲ budget / ✗ error / ✓ ok
  let icon: string;
  if (isRunning) {
    icon = r.queued ? theme.fg("warning", "\u23F8") : theme.fg("warning", "\u23F3");
  } else if (isTimeout) {
    icon = theme.fg("warning", "\u23F1");
  } else if (isBudget) {
    icon = theme.fg("warning", "\u23F2");
  } else if (isError) {
    icon = theme.fg("error", "\u2717");
  } else {
    icon = theme.fg("success", "\u2713");
  }

  const displayItems = buildDisplayItems(r.activityLog);
  const mdTheme = getMarkdownTheme();
  const fg = theme.fg.bind(theme) as (color: string, text: string) => string;

  // Task preview: first line, truncated to one row (always-visible anchor).
  const firstLine = r.task.split("\n")[0];
  const taskPreview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
  // taskline: indicator prefix while running/queued; bare text once finished.
  let taskline: string;
  if (isRunning) {
    const label = r.queued ? "(queued)" : "(running)";
    taskline = `${icon} ${theme.fg("dim", label)} ${theme.fg("text", taskPreview)}`;
  } else {
    taskline = theme.fg("text", taskPreview);
  }

  // usage line: elapsed/budget(+grace) prefix + existing stats.
  const secs = elapsedSeconds(r);
  const stats = formatUsageStats(r.usage, r.model);
  const budgetSec = r.budgetMs ? Math.round(r.budgetMs / 1000) : 0;
  const liveGraceMs = (r.graceMs ?? 0) + (r.pauseStart ? Date.now() - r.pauseStart : 0);
  const graceSec = Math.round(liveGraceMs / 1000);
  let timePart: string | null = null;
  if (secs != null) {
    timePart =
      budgetSec > 0
        ? graceSec > 0
          ? `${secs}s/${budgetSec}s(+${graceSec}s)`
          : `${secs}s/${budgetSec}s`
        : `${secs}s`;
  }
  const usageLine = [timePart, stats].filter(Boolean).join(" \u00b7 ");

  // resultline: fixed line on terminal frames — `<icon> <content>` colored by outcome.
  // success → AI summary, else first line of output (truncated), else a placeholder — never blank.
  // error/timeout/budget → errorMessage (or a default label).
  let resultline: string | undefined;
  if (!isRunning) {
    if (isFailedState) {
      const content =
        r.errorMessage || (isTimeout ? "Timed out" : isBudget ? "Budget exceeded" : "failed");
      const col: ThemeColor = isTimeout || isBudget ? "warning" : "error";
      resultline = `${icon} ${theme.fg(col, content)}`;
    } else {
      // success fallback chain: summary → output first line → placeholder.
      const firstLine = r.output.trim().split("\n")[0] ?? "";
      const preview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
      const content = r.summary || preview;
      const col: ThemeColor = content ? "text" : "muted";
      resultline = `${icon} ${theme.fg(col, content || "(no output)")}`;
    }
  }

  if (expanded) {
    const container = new Container();

    // Header: taskline + resultline (summary on success, error message on failure).
    container.addChild(new Text(taskline, 0, 0));
    if (resultline) {
      container.addChild(new Text(resultline, 0, 0));
    }

    // Input block: reference files + context char count + task full text,
    // grouped without inner spacing (they are all subagent input).
    container.addChild(new Spacer(1));
    if (r.files) {
      for (const f of r.files) {
        container.addChild(new Text(theme.fg("dim", `@${f}`), 0, 0));
      }
    }
    if (r.context) {
      container.addChild(new Text(theme.fg("dim", `ctx ${r.context.length} chars`), 0, 0));
    }
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

    // Activity stream (shown while running and after completion).
    container.addChild(new Spacer(1));
    const activity = displayItems.filter(
      (item) => item.type === "toolCall" || item.type === "thinking",
    );
    if (activity.length === 0) {
      const runningLabel = isRunning
        ? r.queued
          ? "(queued \u2014 waiting for a concurrency slot...)"
          : "(waiting for first event...)"
        : "(none)";
      container.addChild(new Text(theme.fg("muted", runningLabel), 0, 0));
    } else {
      for (const item of activity) {
        if (item.type === "thinking") {
          container.addChild(new Text(formatThinking(item.status, fg), 0, 0));
        } else {
          const { prefix, color } = statusStyle(item.status, fg);
          container.addChild(
            new Text(prefix + formatToolCall(item.name, item.args, color), 0, 0),
          );
        }
      }
    }

    // Full output (terminal runs only). Always render the slot — show a
    // placeholder when empty so the user never thinks output was lost.
    if (!isRunning) {
      container.addChild(new Spacer(1));
      if (r.output.trim()) {
        container.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
        if (r.outputMethod === "compressed") {
          container.addChild(
            new Text(
              theme.fg(
                "muted",
                "(output compressed by summary model \u2014 full text in history)",
              ),
              0,
              0,
            ),
          );
        } else if (r.outputMethod === "truncated") {
          container.addChild(
            new Text(theme.fg("muted", "(output truncated \u2014 full text in history)"), 0, 0),
          );
        }
      } else {
        container.addChild(
          new Text(theme.fg("muted", "(no output \u2014 the run produced no text)"), 0, 0),
        );
      }
    }

    // Usage (with elapsed).
    if (usageLine) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageLine), 0, 0));
    }

    return container;
  }

  // Collapsed view.
  let text = taskline;
  if (!isRunning) {
    // resultline (shared computation above).
    if (resultline) text += `\n${resultline}`;
  } else if (!r.queued) {
    // Running (not queued): show recent activity only.
    const activity = displayItems.filter(
      (item) => item.type === "toolCall" || item.type === "thinking",
    );
    if (activity.length === 0) {
      text += `\n${theme.fg("muted", "(running...)")}`;
    } else {
      const rendered = renderDisplayItems(activity, 5, fg);
      if (rendered) text += `\n${rendered}`;
    }
  }
  if (usageLine) text += `\n${theme.fg("dim", usageLine)}`;
  return new Text(text, 0, 0);
};
