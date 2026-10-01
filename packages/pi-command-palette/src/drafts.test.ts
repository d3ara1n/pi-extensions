import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { applyDraftEditorAction, DraftStore } from "./drafts.ts";

function sandbox(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-palette-drafts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function editor(initial: string) {
  let text = initial;
  return {
    getEditorText: () => text,
    setEditorText: (value: string) => { text = value; },
  };
}

test("save persists exact text before clearing the editor and restores by session ID", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session-a");
  const text = "  后续任务\n\nhttps://example.com/path\n ";
  let current = text;
  applyDraftEditorAction(store, {
    getEditorText: () => current,
    setEditorText(value) {
      assert.equal(new DraftStore(directory, "session-a").items[0].text, text);
      current = value;
    },
  }, { type: "save-draft" });
  assert.equal(current, "");
  assert.deepEqual(new DraftStore(directory, "session-a").items, store.items);
  assert.deepEqual(new DraftStore(directory, "session-b").items, []);
});

test("taking a selected draft swaps occupied editor text in one persisted state", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session");
  store.save("first task");
  const firstId = store.items[0].id;
  store.save("second task");
  const secondId = store.items[0].id;
  const ui = editor("current conversation input");
  applyDraftEditorAction(store, ui, { type: "restore-draft", id: firstId });
  assert.equal(ui.getEditorText(), "first task");
  assert.deepEqual(store.items.map((draft) => draft.text), ["current conversation input", "second task"]);
  assert.equal(store.items[1].id, secondId);
  assert.deepEqual(new DraftStore(directory, "session").items, store.items);
  assert.equal(readFileSync(path.join(directory, "session.json"), "utf8").includes("first task"), false);
});

test("taking into an empty editor removes the draft and saving edits replaces its old content", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session");
  store.save("original draft");
  const ui = editor("");
  applyDraftEditorAction(store, ui, { type: "restore-draft", id: store.items[0].id });
  assert.equal(ui.getEditorText(), "original draft");
  assert.deepEqual(new DraftStore(directory, "session").items, []);
  ui.setEditorText("revised draft");
  applyDraftEditorAction(store, ui, { type: "save-draft" });
  const stored = JSON.parse(readFileSync(path.join(directory, "session.json"), "utf8"));
  assert.deepEqual(stored.drafts.map((draft: { text: string }) => draft.text), ["revised draft"]);
  assert.equal(JSON.stringify(stored).includes("original draft"), false);
});

test("editor-fill commands preserve all previous drafts and current input", (t) => {
  const store = new DraftStore(sandbox(t), "session");
  store.save("planned task");
  const ui = editor("unfinished input");
  applyDraftEditorAction(store, ui, { type: "editor", text: "/some-command" });
  assert.equal(ui.getEditorText(), "/some-command");
  assert.deepEqual(store.items.map((draft) => draft.text), ["unfinished input", "planned task"]);
});

test("delete removes only the selected ID even when drafts have identical text", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session");
  store.save("same text");
  store.save("same text");
  const [latest, earlier] = store.items;
  store.delete(earlier.id);
  assert.deepEqual(new DraftStore(directory, "session").items, [latest]);
  assert.throws(() => store.take(earlier.id, "do not save"), /no longer exists/);
  assert.deepEqual(store.items, [latest]);
});

test("blank input makes no draft file and an unavailable store never discards nonblank input", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session");
  const ui = editor(" \n ");
  assert.equal(applyDraftEditorAction(store, ui, { type: "save-draft" }), false);
  assert.equal(ui.getEditorText(), " \n ");
  assert.deepEqual(readdirSync(directory), []);
  applyDraftEditorAction(undefined, ui, { type: "editor", text: "/command" });
  assert.equal(ui.getEditorText(), "/command");
  assert.throws(() => applyDraftEditorAction(undefined, ui, { type: "save-draft" }), /unavailable/);
  assert.equal(ui.getEditorText(), "/command");
});

test("failed atomic replacement preserves editor and memory and cleans up the temporary file", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "session");
  store.save("saved task");
  const original = store.items;
  const target = path.join(directory, "session.json");
  const backup = path.join(directory, "original.json");
  renameSync(target, backup);
  mkdirSync(target); // Renaming the new file over a directory must fail on every platform.
  const ui = editor("input that must survive");
  for (const action of [
    { type: "save-draft" },
    { type: "restore-draft", id: original[0].id },
    { type: "editor", text: "/command" },
  ] as const) {
    assert.throws(() => applyDraftEditorAction(store, ui, action));
    assert.equal(ui.getEditorText(), "input that must survive");
    assert.deepEqual(store.items, original);
  }
  assert.throws(() => store.delete(original[0].id));
  assert.deepEqual(store.items, original);
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")).drafts, original);
  assert.deepEqual(readdirSync(directory).sort(), ["original.json", "session.json"]);
});

test("malformed or unsupported draft files are rejected without overwriting them", (t) => {
  const directory = sandbox(t);
  const file = path.join(directory, "session.json");
  for (const contents of [
    "{broken",
    '{"version":2,"drafts":[]}',
    '{"version":1,"drafts":[{"id":"x","text":42,"savedAt":"2026-01-01"}]}',
  ]) {
    writeFileSync(file, contents);
    assert.throws(() => new DraftStore(directory, "session"));
    assert.equal(readFileSync(file, "utf8"), contents);
  }
});

test("custom session IDs remain within the draft directory", (t) => {
  const directory = sandbox(t);
  const store = new DraftStore(directory, "../custom/session");
  store.save("task");
  assert.deepEqual(readdirSync(directory), ["..%2Fcustom%2Fsession.json"]);
  assert.deepEqual(new DraftStore(directory, "../custom/session").items, store.items);
});
