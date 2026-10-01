/**
 * pi-command-palette — Global command palette for pi.
 *
 * Open with the Ctrl+Shift+P shortcut (configurable) or the /palette command;
 * the shortcut dispatches the command so the palette runs with full session
 * control (new / reload / resume) available.
 *
 * Press Ctrl+Shift+P to open a searchable command palette overlay,
 * regardless of whether the editor has content.
 *
 * Features:
 * - Single overlay with nested pages: built-in actions on the root page,
 *   extension actions / commands / skills / templates as sub-pages, models
 *   and sessions loaded on first visit
 * - Session operations (new / reload / resume) run pi's session APIs
 *   directly — no editor round-trip
 * - Fuzzy search within the current page; searching the root page matches
 *   every leaf across sub-pages
 * - Floating overlay on top of existing content
 * - Saves editor text as session-scoped drafts before overwriting
 * - Draft list with restore, full-text preview, and deletion
 */

import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, copyToClipboard, DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import {
  Container,
  type SelectItem,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  ScrollView,
  SelectList,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { resolveShortcutKey } from "./config.ts";
import { applyDraftEditorAction, DraftStore, type Draft, type DraftEditorAction } from "./drafts.ts";

// ── Types ──────────────────────────────────────────────────────────

type CommandAction =
  | DraftEditorAction
  | { type: "session-new" }
  | { type: "session-resume"; path: string; label: string }
  | { type: "noop" }
  | { type: "native"; id: string }
  | { type: "model"; provider: string; modelId: string }
  | { type: "compact" }
  | { type: "reload" }
  | { type: "copy-editor" };

interface PaletteItem {
  value: string;
  label: string;
  description: string;
  category: string;
  action: CommandAction;
  searchText?: string;
}

/**
 * Explicit display order for built-in palette entries (lower = higher up).
 * Unlisted built-ins fall back to alphabetical, after the listed ones;
 * non-built-in entries always sort after built-ins.
 */
const BUILTIN_ORDER: Record<string, number> = {
  __restore: 0,
  __copy_editor: 1,
  __save_draft: 2,
};

// ── Helpers ────────────────────────────────────────────────────────

/** Uniform error text for notifications. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
/**
 * Sort ranks: built-in actions first, then native commands registered by other
 * extensions (direct callbacks), then everything that fills the editor with a
 * `/command`. Lower rank = higher up in the palette.
 */
function paletteSortRank(item: PaletteItem): number {
  if (item.category === "Built-in") return 0;
  if (item.action.type === "native") return 1;
  return 2;
}

/**
 * @internal — exported for testing; builds the palette item list from
 * built-ins, the native-command registry, and pi's command registry.
 */
export function buildPaletteItems(pi: ExtensionAPI, drafts: readonly Draft[] = []): PaletteItem[] {
  const items: PaletteItem[] = [];

  // Resolve the latest draft before any editor text is saved during restore.
  const latest = drafts[0];
  if (latest) {
    items.push({
      value: "__restore",
      label: "Editor: Restore Latest Draft",
      description: firstMessagePreview(latest.text),
      category: "Built-in",
      action: { type: "restore-draft", id: latest.id },
    });
  }

  // ── Built-in actions ──────────────────────────────────────────
  items.push({
    value: "__new_session",
    label: "Session: New",
    description: "Start a new session",
    category: "Built-in",
    action: { type: "session-new" },
  });

  items.push({
    value: "__compact",
    label: "Session: Compact",
    description: "Compact conversation to free context",
    category: "Built-in",
    action: { type: "compact" },
  });

  items.push({
    value: "__reload",
    label: "Session: Reload",
    description: "Reload extensions, skills, and config",
    category: "Built-in",
    action: { type: "reload" },
  });

  items.push({
    value: "__copy_editor",
    label: "Editor: Copy Content",
    description: "Copy current editor text to clipboard",
    category: "Built-in",
    action: { type: "copy-editor" },
  });

  items.push({
    value: "__save_draft",
    label: "Editor: Save Draft",
    description: "Save current editor text as a draft and clear the editor",
    category: "Built-in",
    action: { type: "save-draft" },
  });

  // ── Native commands from other extensions ────────────────────
  // Direct callbacks registered via @d3ara1n/pi-command-palette-core —
  // executed in place, never touching the editor. Read at palette-open time,
  // so late registrations are visible the next time the palette opens.
  for (const cmd of paletteCommandRegistry.getAll()) {
    items.push({
      value: `native:${cmd.id}`,
      label: cmd.label,
      description: cmd.description ?? "",
      category: "Native",
      action: { type: "native", id: cmd.id },
    });
  }

  // ── Extension commands, skills, templates ────────────────────
  const commands = pi.getCommands();
  for (const cmd of commands) {
    const editorText = `/${cmd.name}`;
    const sourceLabel =
      cmd.source === "extension" ? "Command" : cmd.source === "skill" ? "Skill" : "Template";

    items.push({
      value: `cmd:${cmd.name}`,
      label: `/${cmd.name}`,
      description: cmd.description ?? "",
      category: sourceLabel,
      action: { type: "editor", text: editorText },
    });
  }

  // Sort: built-in actions first (ordered by BUILTIN_ORDER, then alphabetical),
  // then native commands, then editor-fill entries — each group alphabetical.
  items.sort((a, b) => {
    const ar = paletteSortRank(a);
    const br = paletteSortRank(b);
    if (ar !== br) return ar - br;
    if (ar === 0) {
      const ai = BUILTIN_ORDER[a.value] ?? Number.MAX_SAFE_INTEGER;
      const bi = BUILTIN_ORDER[b.value] ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
    }
    return a.label.localeCompare(b.label);
  });

  return items;
}

// ── Partitioned fuzzy filter ───────────────────────────────────────

/**
 * Filter two partitions independently and concatenate them in a stable order:
 * every matching item from `primary`, then every matching item from
 * `secondary`. Each group is ranked by fuzzy score on its own, so `primary`
 * always stays on top — a single {@link fuzzyFilter} call flattens both groups
 * into one score-ordered list and erases the boundary between them.
 *
 * An empty (or whitespace-only) query returns `[...primary, ...secondary]`
 * unchanged.
 *
 * @internal — exported for testing; the model selector is the only caller.
 */
export function partitionedFuzzyFilter<T>(
  primary: T[],
  secondary: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return [...primary, ...secondary];
  return [...fuzzyFilter(primary, query, getText), ...fuzzyFilter(secondary, query, getText)];
}

// ── Command palette overlay ────────────────────────────────────────

interface PageEntry {
  type: "page";
  value: string;
  label: string;
  description: string;
  page: PalettePage;
}

interface PalettePage {
  title: string;
  items: Array<PaletteItem | PageEntry>;
}

function pageItem(value: string, label: string, description: string, page: PalettePage): PageEntry {
  return { type: "page", value, label, description, page };
}

// ── Session list helpers ──────────────────────────────────────────

/** One entry of SessionManager.list() — avoided a direct type import. */
type SessionSummary = Awaited<ReturnType<typeof SessionManager.list>>[number];

/** Compact relative time for session list descriptions. */
function timeAgo(date: Date): string {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

/** Single-line preview of a session's first message. */
function firstMessagePreview(text: string, max = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single || "(empty)";
}

/** Inert placeholder row for the Sessions page — renders a state, does nothing when selected. */
function sessionPlaceholder(label: string): PaletteItem {
  return {
    value: "__sessions_placeholder",
    label,
    description: "",
    category: "Sessions",
    action: { type: "noop" },
  };
}

/** Map SessionManager.list() results to palette items. */
function sessionItems(sessions: readonly SessionSummary[], currentFile: string | undefined): PaletteItem[] {
  return sessions.map((info) => {
    const label = info.name?.trim() || firstMessagePreview(info.firstMessage);
    const isCurrent =
      currentFile !== undefined && path.resolve(currentFile) === path.resolve(info.path);
    return {
      value: `session:${info.path}`,
      label,
      description: `${timeAgo(info.modified)} · ${info.messageCount} messages${isCurrent ? " · current" : ""}`,
      category: "Sessions",
      action: { type: "session-resume", path: info.path, label },
    };
  });
}

function draftItem(draft: Draft): PaletteItem {
  return {
    value: `draft:${draft.id}`,
    label: firstMessagePreview(draft.text),
    description: `${timeAgo(new Date(draft.savedAt))} · ${draft.text.split("\n").length} lines`,
    category: "Drafts",
    action: { type: "restore-draft", id: draft.id },
    searchText: draft.text,
  };
}

async function showCommandPalette(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  drafts: DraftStore | undefined,
): Promise<void> {
  if (ctx.mode !== "tui") return;

  const paletteItems = buildPaletteItems(pi, drafts?.items);
  const leaves = (category: string) =>
    paletteItems.filter((item) => item.category === category);
  const leafPage = (title: string, items: PaletteItem[]): PalettePage => ({ title, items });

  const builtins = leaves("Built-in");
  const native = leaves("Native");
  const commands = leaves("Command");
  const skills = leaves("Skill");
  const templates = leaves("Template");
  // Leaves reachable only through sub-pages — merged into the root list
  // while searching there. Built-in leaves live on the root page itself.
  const subLeaves = paletteItems.filter((item) => item.category !== "Built-in");
  const modelPage: PalettePage = { title: "Models", items: [] };
  const sessionsPage: PalettePage = { title: "Sessions", items: [] };
  const draftsPage: PalettePage = { title: "Drafts", items: [] };
  const draftsEntry = pageItem("drafts", "Drafts", "Saved editor text", draftsPage);
  /** Set once the Sessions page load has been kicked off (one per palette open). */
  let sessionsLoadStarted = false;
  /** Cleared when the palette overlay closes; guards late async callbacks. */
  let paletteOpen = true;
  const rootItems: PalettePage["items"] = [
    draftsEntry,
    pageItem("models", "Models", "Switch the active model", modelPage),
    pageItem("sessions", "Sessions", "Resume a previous session", sessionsPage),
    // Built-in actions sit directly on the root page so urgent entries like
    // Restore are visible without descending into a sub-page.
    ...builtins,
    ...(native.length ? [pageItem("native", "Extension Actions", "Actions provided by extensions", leafPage("Extension Actions", native))] : []),
    ...(commands.length ? [pageItem("commands", "Commands", "Extension slash commands", leafPage("Commands", commands))] : []),
    ...(skills.length ? [pageItem("skills", "Skills", "Installed skills", leafPage("Skills", skills))] : []),
    ...(templates.length ? [pageItem("templates", "Templates", "Prompt templates", leafPage("Templates", templates))] : []),
  ];
  const root: PalettePage = { title: "Command Palette", items: rootItems };

  function refreshDrafts() {
    const items = drafts?.items ?? [];
    draftsEntry.label = drafts ? `Drafts (${items.length})` : "Drafts (unavailable)";
    const entries = items.map(draftItem);
    draftsPage.items = entries.length ? entries : [{
      value: "__drafts_placeholder",
      label: drafts ? "No drafts saved" : "Drafts unavailable",
      description: drafts ? "Use Editor: Save Draft to save your input" : "Resolve the storage error and reopen the palette",
      category: "Drafts",
      action: { type: "noop" },
    }];
    for (let i = subLeaves.length - 1; i >= 0; i--) {
      if (subLeaves[i].category === "Drafts") subLeaves.splice(i, 1);
    }
    subLeaves.push(...entries);
    const restoreIndex = root.items.findIndex((item) => item.value === "__restore");
    if (restoreIndex >= 0) root.items.splice(restoreIndex, 1);
    const restore = buildPaletteItems(pi, items).find((item) => item.value === "__restore");
    if (restore) {
      const firstBuiltin = root.items.findIndex((item) => "action" in item && item.category === "Built-in");
      root.items.splice(firstBuiltin < 0 ? root.items.length : firstBuiltin, 0, restore);
    }
  }
  refreshDrafts();

  // Captured from the overlay factory so palette actions can request a
  // render after mutating editor state (see the action switch below).
  let tuiRef: TUI | undefined;

  /** Scoped-model marker prefix (★). */
  const STAR = "★ ";

  /**
   * Build the model list for the Models page: scoped models (★) first, then
   * the rest — alphabetical within each group. Reads the registry
   * synchronously; throws if enumeration fails.
   */
  function buildModelItems(): PaletteItem[] {
    const scopedIds = new Set(ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
    return ctx.modelRegistry
      .getAvailable()
      .map((m): PaletteItem => {
        const scoped = scopedIds.has(`${m.provider}/${m.id}`);
        return {
          value: `${m.provider}/${m.id}`,
          label: scoped ? `${STAR}${m.name}` : m.name,
          description: m.provider,
          category: "Models",
          action: { type: "model", provider: m.provider, modelId: m.id },
        };
      })
      .sort((a, b) => {
        const aScoped = scopedIds.has(a.value);
        const bScoped = scopedIds.has(b.value);
        if (aScoped !== bScoped) return aScoped ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }

  // TODO(mouse): pi's fullscreen TUI (default since 1.0) routes normalized mouse
  // events to components. Add click-to-pick for list items and wheel scrolling
  // for the list/preview, keeping a keyboard path for every interaction
  // ("regular" mode leaves the mouse to the terminal).

  const result = await ctx.ui.custom<PaletteItem | null>(
    (tui, theme, _kb, done) => {
      tuiRef = tui;
      const container = new Container();
      const listHost = new Container();
      const queryInput = new Input();
      let focused = true;
      const stack: Array<{ page: PalettePage; input: string; selectedValue?: string }> = [
        { page: root, input: "" },
      ];
      let selectList!: SelectList;
      let visibleItems: Array<PaletteItem | PageEntry> = [];
      let preview: { draft: Draft; text: Text; scroll: ScrollView } | undefined;

      const listTheme = {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      };

      function current() {
        return stack[stack.length - 1]!;
      }

      function rebuild() {
        const { page } = current();
        const query = queryInput.getValue();
        visibleItems =
          page === root && query.trim() ? [...root.items, ...subLeaves] : page.items;
        const items = visibleItems.map((item) => ({
          value: item.value,
          label: item.label,
          searchText: "action" in item ? item.searchText : undefined,
          description:
            page === root && query.trim() && !("page" in item)
              ? `${item.category} › ${item.description}`
              : item.description,
        }));
        const getText = (item: SelectItem & { searchText?: string }) =>
          `${item.label} ${item.description ?? ""} ${item.searchText ?? ""}`;
        const filtered = query
          ? page === modelPage
            ? partitionedFuzzyFilter(
                items.filter((item) => item.label.startsWith(STAR)),
                items.filter((item) => !item.label.startsWith(STAR)),
                query,
                getText,
              )
            : fuzzyFilter(items, query, getText)
          : items;
        // Label/description split is 5:5 on every palette page: the primary
        // column is pinned to half the list width instead of SelectList's
        // default fixed 32 columns (~3:7 on wide terminals). The overlay spans
        // 70% of the terminal with a floor of 50 columns (overlayOptions
        // below); the 32-column floor keeps narrow terminals on the old default.
        const overlayWidth = Math.max(50, Math.floor(tui.terminal.columns * 0.7));
        const primaryColumn = Math.max(32, Math.floor(overlayWidth / 2));
        selectList = new SelectList(
          filtered,
          Math.min(Math.max(filtered.length, 1), 15),
          listTheme,
          { minPrimaryColumnWidth: primaryColumn, maxPrimaryColumnWidth: primaryColumn },
        );
        const restoredIndex = filtered.findIndex(
          (item) => item.value === current().selectedValue,
        );
        if (restoredIndex >= 0) selectList.setSelectedIndex(restoredIndex);
        listHost.clear();
        listHost.addChild(selectList);
        selectList.onSelect = (selected) => {
          current().selectedValue = selected.value;
          const item = visibleItems.find((candidate) => candidate.value === selected.value);
          if (!item) return;
          if (!("page" in item)) {
            if (item.action.type === "noop") return;
            done(item);
            return;
          }
          // Entering the Models page loads the registry once per palette
          // session; later visits reuse the cached list.
          if (item.page === modelPage && item.page.items.length === 0) {
            try {
              item.page.items = buildModelItems();
            } catch {
              ctx.ui.notify("Cannot enumerate models. Use Ctrl+L instead.", "warning");
              return;
            }
            if (item.page.items.length === 0) {
              ctx.ui.notify("No models available.", "warning");
              return;
            }
          }
          // Entering the Sessions page kicks off an async load once per
          // palette session; partial results stream in via onProgress and
          // replace the placeholder as they arrive.
          if (item.page === sessionsPage && !sessionsLoadStarted) {
            sessionsPage.items = [sessionPlaceholder("Loading sessions…")];
            startSessionLoad();
          }
          pushPage(item.page);
        };
        selectList.onSelectionChange = (selected) => {
          current().selectedValue = selected.value;
        };
      }

      // Breadcrumb title: updated in place whenever the page stack changes.
      const titleText = new Text(theme.fg("accent", theme.bold(root.title)), 1, 0);

      function updateTitle() {
        titleText.setText(
          theme.fg("accent", theme.bold(stack.map((frame) => frame.page.title).join(" › "))),
        );
      }

      function pushPage(page: PalettePage) {
        current().input = queryInput.getValue();
        stack.push({ page, input: "" });
        queryInput.setValue("");
        updateTitle();
        rebuild();
        tui.requestRender();
      }

      function popPage() {
        if (stack.length <= 1) return;
        stack.pop();
        queryInput.setValue(current().input);
        updateTitle();
        rebuild();
        tui.requestRender();
      }

      function selectedDraft(): Draft | undefined {
        if (preview) return preview.draft;
        const selected = selectList.getSelectedItem();
        const item = visibleItems.find((candidate) => candidate.value === selected?.value);
        if (!item || !("action" in item) || item.action.type !== "restore-draft") return;
        const id = item.action.id;
        return drafts?.items.find((draft) => draft.id === id);
      }

      function deleteDraft(draft: Draft) {
        try {
          if (!drafts) return;
          drafts.delete(draft.id);
          preview = undefined;
          queryInput.focused = focused;
          refreshDrafts();
          rebuild();
          tui.requestRender();
        } catch (err) {
          ctx.ui.notify(`Failed to delete draft: ${errorMessage(err)}`, "error");
        }
      }

      /**
       * Load the session list for the Sessions page. Mirrors the native
       * /resume picker's loaders: project-scoped, sorted by activity, with
       * partial results delivered through onProgress so the list fills in
       * progressively instead of paging.
       */
      function startSessionLoad() {
        sessionsLoadStarted = true;
        const currentFile = ctx.sessionManager.getSessionFile();
        const apply = (sessions: readonly SessionSummary[]) => {
          sessionsPage.items = sessions.length
            ? sessionItems(sessions, currentFile)
            : [sessionPlaceholder("No sessions found")];
          rebuild();
          tui.requestRender();
        };
        SessionManager.list(
          ctx.sessionManager.getCwd(),
          ctx.sessionManager.getSessionDir(),
          (_loaded, _total, partial) => {
            if (!paletteOpen || !partial) return;
            apply(partial);
          },
        )
          .then((sessions) => {
            if (!paletteOpen) return;
            apply(sessions);
          })
          .catch((err) => {
            if (!paletteOpen) return;
            sessionsPage.items = [sessionPlaceholder("Failed to load sessions")];
            rebuild();
            tui.requestRender();
            ctx.ui.notify(`Failed to load sessions: ${errorMessage(err)}`, "error");
          });
      }

      rebuild();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(titleText);
      container.addChild(queryInput);
      container.addChild(listHost);
      const hintText = new Text("", 1, 0);
      container.addChild(hintText);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          queryInput.focused = value && !preview;
        },
        render(w: number) {
          if (preview) {
            const border = new DynamicBorder((s: string) => theme.fg("accent", s)).render(w);
            const header = new Text(theme.fg("accent", "Draft Preview"), 1, 0).render(w);
            const hints = new Text(theme.fg("dim",
              "↑↓/pgup/pgdn scroll • enter restore • ctrl+d delete • backspace return • esc close"), 1, 0).render(w);
            const lines = preview.scroll.render(w);
            const height = Math.max(1, Math.floor(tui.terminal.rows * 0.8)
              - border.length * 2 - header.length - hints.length - 1);
            preview.scroll.updateLayout(lines.length, height, () => tui.requestRender());
            const start = preview.scroll.scrollTop;
            const position = new Text(theme.fg("muted",
              `${start + 1}–${Math.min(start + height, lines.length)} / ${lines.length}`), 1, 0).render(w);
            return [...border, ...header, ...lines.slice(start, start + height), ...position, ...hints, ...border];
          }
          const draft = selectedDraft();
          hintText.setText(theme.fg("dim", draft
            ? "↑↓ navigate • enter restore • ctrl+p preview • ctrl+d delete • backspace go back • esc close"
            : "↑↓ navigate • enter open/select • backspace go back • esc close"));
          return container.render(w);
        },
        invalidate() {
          container.invalidate();
          queryInput.invalidate();
          selectList.invalidate();
          preview?.text.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
          const draft = selectedDraft();
          if (draft && matchesKey(data, Key.ctrl("d"))) {
            deleteDraft(draft);
            return;
          }
          if (preview) {
            if (matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("p"))) {
              preview = undefined;
              queryInput.focused = focused;
            } else if (matchesKey(data, Key.enter)) {
              done(draftItem(preview.draft));
            } else if (matchesKey(data, Key.up)) {
              preview.scroll.scrollBy(-1);
            } else if (matchesKey(data, Key.down)) {
              preview.scroll.scrollBy(1);
            } else if (matchesKey(data, Key.pageUp)) {
              preview.scroll.scrollBy(-preview.scroll.viewportHeight);
            } else if (matchesKey(data, Key.pageDown)) {
              preview.scroll.scrollBy(preview.scroll.viewportHeight);
            } else if (matchesKey(data, Key.home)) {
              preview.scroll.scrollToStart();
            } else if (matchesKey(data, Key.end)) {
              preview.scroll.scrollToEnd();
            }
            tui.requestRender();
            return;
          }
          if (draft && matchesKey(data, Key.ctrl("p"))) {
            const text = new Text(draft.text, 1, 0);
            preview = { draft, text, scroll: new ScrollView(text) };
            queryInput.focused = false;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.backspace) && queryInput.getValue().length === 0) {
            popPage();
            return;
          }
          if (
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.enter)
          ) {
            selectList.handleInput(data);
          } else {
            const before = queryInput.getValue();
            queryInput.handleInput(data);
            if (queryInput.getValue() !== before) {
              current().selectedValue = undefined;
              rebuild();
            }
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", minWidth: 50 } },
  );

  // The overlay is closed from here on — block late session-load callbacks.
  paletteOpen = false;

  if (!result) return;

  // Execute the selected action
  const action = result.action;
  // Set when an action replaced the extension runtime (reload): every
  // captured reference below is dead, so nothing may run afterwards.
  let runtimeReplaced = false;
  switch (action.type) {
    case "native": {
      const cmd = paletteCommandRegistry.get(action.id);
      if (!cmd) {
        ctx.ui.notify(`Palette command not found: ${action.id}`, "warning");
        break;
      }
      try {
        await cmd.run(pi, ctx);
      } catch (err) {
        ctx.ui.notify(`Palette command "${cmd.label}" failed: ${errorMessage(err)}`, "error");
      }
      break;
    }
    case "session-new": {
      try {
        // The captured command context is invalid after session replacement,
        // so post-switch work runs in withSession on the fresh context.
        const outcome = await ctx.newSession({
          withSession: async (fresh) => {
            fresh.ui.notify("New session started", "info");
          },
        });
        // cancelled = a session_before_switch handler vetoed; stay silent,
        // matching native /new.
        if (outcome.cancelled) break;
      } catch (err) {
        ctx.ui.notify(`Failed to create session: ${errorMessage(err)}`, "error");
      }
      break;
    }
    case "restore-draft":
    case "save-draft":
    case "editor": {
      try {
        const changed = applyDraftEditorAction(drafts, ctx.ui, action);
        if (action.type === "save-draft") {
          ctx.ui.notify(changed ? "Draft saved" : "Editor is empty", changed ? "info" : "warning");
        }
      } catch (err) {
        ctx.ui.notify(`Could not update editor: ${errorMessage(err)}`, "error");
      }
      break;
    }
    case "model": {
      const model = ctx.modelRegistry.find(action.provider, action.modelId);
      if (model) {
        const success = await pi.setModel(model);
        ctx.ui.notify(
          success ? `Model: ${action.provider}/${action.modelId}` : `No API key for ${action.provider}/${action.modelId}`,
          success ? "info" : "error",
        );
      }
      break;
    }
    case "compact": {
      ctx.compact({
        onComplete: () => ctx.ui.notify("Compaction completed", "info"),
        onError: (err) => ctx.ui.notify(`Compaction failed: ${err.message}`, "error"),
      });
      break;
    }
    case "reload": {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current response to finish before reloading", "warning");
        break;
      }
      try {
        // Reload replaces the extension runtime: this closure, the module
        // state, and every captured reference die here. Await it last and
        // return without touching anything afterwards.
        await ctx.reload();
        runtimeReplaced = true;
      } catch (err) {
        ctx.ui.notify(`Reload failed: ${errorMessage(err)}`, "error");
      }
      break;
    }
    case "session-resume": {
      const currentFile = ctx.sessionManager.getSessionFile();
      if (currentFile && path.resolve(currentFile) === path.resolve(action.path)) {
        ctx.ui.notify("Already in this session", "info");
        break;
      }
      try {
        // Acknowledge before the dead-air window: session replacement loads
        // the target session and re-runs session_start hooks, and only a
        // transcript status line (chat content, not extension UI) survives
        // the teardown — it clears when the new session renders.
        ctx.ui.notify(`Switching to ${action.label}…`, "info");
        // Post-switch work runs on the fresh context — the captured command
        // context is invalid after session replacement.
        const outcome = await ctx.switchSession(action.path, {
          withSession: async (fresh) => {
            fresh.ui.notify(`Switched to ${action.label}`, "info");
          },
        });
        if (outcome.cancelled) {
          // Vetoed before teardown, so this context is still live; the tail
          // status line updates in place instead of leaving "Switching…" dangling.
          ctx.ui.notify("Session switch cancelled", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed to switch session: ${errorMessage(err)}`, "error");
      }
      break;
    }
    case "noop":
      break;
    case "copy-editor": {
      const text = ctx.ui.getEditorText();
      if (text && text.trim()) {
        await copyToClipboard(text);
        ctx.ui.notify("Copied editor text to clipboard", "info");
      } else {
        ctx.ui.notify("Editor is empty", "warning");
      }
      break;
    }
  }

  if (runtimeReplaced) return;

  // The overlay close renders the underlying UI before this promise
  // resolves, and setEditorText mutates state without requesting a render —
  // without this, the editor shows stale text until the next keypress.
  tuiRef?.requestRender();
}

// ── Extension entry point ──────────────────────────────────────────

export default function commandPaletteExtension(pi: ExtensionAPI) {
  let drafts: DraftStore | undefined;
  function loadDrafts(ctx: ExtensionContext) {
    drafts = undefined;
    if (ctx.mode !== "tui") return;
    try {
      drafts = new DraftStore(
        path.join(homedir(), CONFIG_DIR_NAME, "command-palette", "drafts"),
        ctx.sessionManager.getSessionId(),
      );
    } catch (err) {
      ctx.ui.notify(`Failed to load drafts: ${errorMessage(err)}`, "error");
    }
  }
  pi.on("session_start", (_event, ctx) => loadDrafts(ctx));

  // The palette opens through the command handler so it receives
  // ExtensionCommandContext, which carries the session operations
  // (newSession/fork/switchSession/navigateTree/reload). Those are command-only
  // by design: shortcut handlers and lifecycle hooks get a plain context.
  pi.registerCommand("palette", {
    description: "Open the command palette",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The command palette requires TUI mode.", "warning");
        return;
      }
      // Refresh on open so externally changed draft files are not cached indefinitely.
      loadDrafts(ctx);
      await showCommandPalette(pi, ctx, drafts);
    },
  });

  pi.registerShortcut(resolveShortcutKey(), {
    description: "Open command palette",
    handler: async () => {
      // Dispatch the palette command instead of opening the palette directly.
      // With expandPromptTemplates, prompt()'s command branch executes the
      // registered command and returns before any session entry is written or
      // an agent turn starts — also safe while the agent is streaming. This is
      // the documented channel for dispatching extension commands.
      await pi.sendUserMessage("/palette", { expandPromptTemplates: true });
    },
  });
}
