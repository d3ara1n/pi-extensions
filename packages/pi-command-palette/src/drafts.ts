import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** @internal — persisted draft data owned by the command palette. */
export interface Draft {
  readonly id: string;
  readonly text: string;
  readonly savedAt: string;
}

function parseDrafts(raw: string): Draft[] {
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.drafts)) {
    throw new Error("Unsupported draft file format");
  }
  const ids = new Set<string>();
  for (const draft of data.drafts) {
    if (
      !draft || typeof draft.id !== "string" || !draft.id || ids.has(draft.id) ||
      typeof draft.text !== "string" || !draft.text.trim() ||
      typeof draft.savedAt !== "string" || !Number.isFinite(Date.parse(draft.savedAt))
    ) {
      throw new Error("Invalid draft file contents");
    }
    ids.add(draft.id);
  }
  return data.drafts;
}

function newDraft(text: string): Draft {
  return { id: randomUUID(), text, savedAt: new Date().toISOString() };
}

/**
 * @internal — current draft state for one session, independent of its branch.
 * All mutations persist before publishing the new in-memory list.
 */
export class DraftStore {
  private drafts: Draft[] = [];
  private readonly file: string;

  constructor(directory: string, sessionId: string) {
    if (!sessionId) throw new Error("Missing session ID for drafts");
    this.file = path.join(directory, `${encodeURIComponent(sessionId)}.json`);
    try {
      this.drafts = parseDrafts(readFileSync(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get items(): readonly Draft[] {
    return this.drafts.map((draft) => ({ ...draft }));
  }

  save(text: string): boolean {
    if (!text.trim()) return false;
    this.commit([newDraft(text), ...this.drafts]);
    return true;
  }

  take(id: string, editorText: string): string {
    const draft = this.drafts.find((item) => item.id === id);
    if (!draft) throw new Error("Draft no longer exists. Reopen the palette to refresh.");
    const next = this.drafts.filter((item) => item.id !== id);
    if (editorText.trim()) next.unshift(newDraft(editorText));
    this.commit(next);
    return draft.text;
  }

  delete(id: string): void {
    if (!this.drafts.some((item) => item.id === id)) {
      throw new Error("Draft no longer exists. Reopen the palette to refresh.");
    }
    this.commit(this.drafts.filter((item) => item.id !== id));
  }

  private commit(next: Draft[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, drafts: next }, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
    }
    this.drafts = next;
  }
}

/** @internal — editor mutations that may transfer text to or from drafts. */
export type DraftEditorAction =
  | { type: "save-draft" }
  | { type: "restore-draft"; id: string }
  | { type: "editor"; text: string };

/**
 * @internal — shared by menu and list actions; synchronous persistence keeps
 * the editor unchanged on write failure, without an asynchronous editing gap.
 */
export function applyDraftEditorAction(
  store: DraftStore | undefined,
  editor: { getEditorText(): string; setEditorText(text: string): void },
  action: DraftEditorAction,
): boolean {
  const current = editor.getEditorText();
  if (action.type === "editor" && !current.trim()) {
    editor.setEditorText(action.text);
    return true;
  }
  if (action.type === "save-draft" && !current.trim()) return false;
  if (!store) throw new Error("Drafts are unavailable. Reopen the palette after resolving the storage error.");
  if (action.type === "restore-draft") {
    const text = store.take(action.id, current);
    editor.setEditorText(text);
  } else {
    store.save(current);
    editor.setEditorText(action.type === "editor" ? action.text : "");
  }
  return true;
}
