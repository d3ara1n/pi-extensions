/**
 * TUI rendering for the delegate tool: the call row (`subagent_delegate <role>`)
 * and the result view (collapsed and expanded). Shared composition helpers
 * (icons, result lines, timers) live in ./utils.ts and are used by
 * ./render-async.ts too, so every view renders an outcome the same way.
 */

import { getMarkdownTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentDetails } from "./types.ts";
import {
  buildDisplayItems,
  clearElapsedTimer,
  collapsedText,
  contentText,
  ensureElapsedTimer,
  formatFallback,
  formatInheritedConversationInput,
  formatDisplayItem,
  formatTimePart,
  formatUsageStats,
  renderDisplayItems,
  runIcon,
  taskPreview,
  terminalResultLine,
} from "./utils.ts";

// Contextual types derived from ToolDefinition so we don't depend on
// non-root-exported render types (ToolRenderContext is internal).
type RenderCallFn = NonNullable<ToolDefinition["renderCall"]>;
type RenderResultFn = NonNullable<ToolDefinition["renderResult"]>;

// ── renderCall: what the user sees when the tool is invoked ─────

export const renderDelegateCall: RenderCallFn = (args, theme, _context) => {
  const roleName = (args as any).role || "...";
  const inheritance = (args as any).inheritConversation
    ? theme.fg("dim", " (inherits conversation)")
    : "";
  const text =
    theme.fg("toolTitle", theme.bold("subagent_delegate ")) +
    theme.fg("accent", roleName) +
    inheritance;
  return new Text(text, 0, 0);
};

// ── renderResult: TUI display when the tool finishes ────────

export const renderDelegateResult: RenderResultFn = (result, { expanded }, theme, context) => {
  const details = result.details as SubagentDetails | undefined;
  const isRunning = !!details?.results[0] && details.results[0].exitCode === -1;

  // Tick elapsed time every second while running; stop once terminal.
  // Placed BEFORE the missing-details early return so every terminal path
  // still clears the timer — otherwise the interval leaks a permanent
  // 1 Hz re-render per row. The timer calls context.invalidate() so the
  // render recomputes elapsed time fresh from Date.now() without dirtying
  // the data layer.
  if (isRunning) {
    ensureElapsedTimer(context);
  } else {
    clearElapsedTimer(context);
  }

  if (!details || details.results.length === 0) {
    return collapsedText(contentText(result));
  }

  const r = details.results[0];
  const fg = theme.fg.bind(theme) as (color: string, text: string) => string;
  const icon = runIcon(r, fg);
  const displayItems = buildDisplayItems(r.activityLog);
  const mdTheme = getMarkdownTheme();

  // taskline: indicator prefix while running/queued; bare text once finished.
  const preview = taskPreview(r.task);
  let taskline: string;
  if (isRunning) {
    const label = r.queued ? "(queued)" : "(running)";
    taskline = `${icon} ${theme.fg("dim", label)} ${theme.fg("text", preview)}`;
  } else {
    taskline = theme.fg("text", preview);
  }

  // usage line: elapsed/budget(+grace) prefix + stats.
  const stats = formatUsageStats(r.usage, r.model);
  const usageLine = [formatTimePart(r), stats].filter(Boolean).join(" \u00b7 ");

  // resultline: fixed line on terminal frames — the shared chain (failure or
  // budget reason on stops, summary → first output line → placeholder on success).
  const resultline = isRunning ? undefined : terminalResultLine(r, fg);

  // Fallback trace: the role's primary model hit a provider error and the run is
  // being / was retried on the fallback role — warn, don't error (the retry may
  // still succeed). Also shown while the retry is running.
  const fallbackLine = r.fallbackFrom
    ? theme.fg("warning", `\u26a0 fallback: ${formatFallback(r.fallbackFrom)}`)
    : undefined;

  if (expanded) {
    const container = new Container();

    // Header: taskline + resultline (summary on success, reason on failure).
    container.addChild(new Text(taskline, 0, 0));
    if (resultline) {
      container.addChild(new Text(resultline, 0, 0));
    }
    if (fallbackLine) {
      container.addChild(new Text(fallbackLine, 0, 0));
    }

    // Input block: reference files + context/inherited-conversation metadata
    // + task full text, grouped without inner spacing (all subagent input).
    container.addChild(new Spacer(1));
    if (r.files) {
      for (const f of r.files) {
        container.addChild(new Text(theme.fg("dim", `@${f}`), 0, 0));
      }
    }
    if (r.context) {
      container.addChild(new Text(theme.fg("dim", `ctx ${r.context.length} chars`), 0, 0));
    }
    if (r.inheritConversation) {
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            formatInheritedConversationInput(
              r.inheritedConversationChars ?? 0,
              r.inheritedConversationTruncated === true,
            ),
          ),
          0,
          0,
        ),
      );
    }
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

    // Activity stream (shown while running and after completion).
    container.addChild(new Spacer(1));
    if (displayItems.length === 0) {
      const runningLabel = isRunning
        ? r.queued
          ? "(queued \u2014 waiting for a concurrency slot...)"
          : "(waiting for first event...)"
        : "(none)";
      container.addChild(new Text(theme.fg("muted", runningLabel), 0, 0));
    } else {
      for (const item of displayItems) {
        const row = formatDisplayItem(item, fg);
        container.addChild(item.type === "steer" ? collapsedText(row) : new Text(row, 0, 0));
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
    // Terminal: taskline + resultline + usage — no activity replay.
    if (resultline) text += `\n${resultline}`;
  } else if (!r.queued) {
    // Running (not queued): show recent activity only.
    if (displayItems.length === 0) {
      text += `\n${theme.fg("muted", "(running...)")}`;
    } else {
      const rendered = renderDisplayItems(displayItems, 5, fg);
      if (rendered) text += `\n${rendered}`;
    }
  }
  if (fallbackLine) text += `\n${fallbackLine}`;
  if (usageLine) text += `\n${theme.fg("dim", usageLine)}`;
  return collapsedText(text);
};
