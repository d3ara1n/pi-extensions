import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import contextIncludeExtension, { extractReferences } from "./index.ts";

describe("extractReferences", () => {
  // ── basic resolution ──

  it("resolves relative path", () => {
    const refs = extractReferences("@docs/api.md");
    assert.deepStrictEqual(refs, ["docs/api.md"]);
  });

  it("resolves explicit relative path", () => {
    const refs = extractReferences("@./local-rules.md");
    assert.deepStrictEqual(refs, ["./local-rules.md"]);
  });

  it("resolves parent relative path", () => {
    const refs = extractReferences("@../shared/AGENTS.md");
    assert.deepStrictEqual(refs, ["../shared/AGENTS.md"]);
  });

  it("resolves absolute path", () => {
    const refs = extractReferences("@/etc/config.toml");
    assert.deepStrictEqual(refs, ["/etc/config.toml"]);
  });

  it("resolves home directory path", () => {
    const refs = extractReferences("@~/.agents/CODEGRAPH.md");
    assert.deepStrictEqual(refs, ["~/.agents/CODEGRAPH.md"]);
  });

  // ── supported extensions ──

  it("matches all supported extensions", () => {
    const content = [
      "@file.md",
      "@file.txt",
      "@file.yaml",
      "@file.yml",
      "@file.json",
      "@file.toml",
    ].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, [
      "file.md",
      "file.txt",
      "file.yaml",
      "file.yml",
      "file.json",
      "file.toml",
    ]);
  });

  it("ignores unsupported extension", () => {
    const refs = extractReferences("@script.py");
    assert.deepStrictEqual(refs, []);
  });

  it("ignores path without extension", () => {
    const refs = extractReferences("@Dockerfile");
    assert.deepStrictEqual(refs, []);
  });

  // ── multiple references ──

  it("extracts multiple references", () => {
    const content = ["# My Rules", "@rules.md", "@docs/api.md", "@docs/auth.md"].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, ["rules.md", "docs/api.md", "docs/auth.md"]);
  });

  // ── deduplication ──

  it("deduplicates identical references", () => {
    const content = ["@rules.md", "@rules.md", "@rules.md"].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, ["rules.md"]);
  });

  // ── @ at line start enforcement ──

  it("ignores inline @ (email-like pattern)", () => {
    const refs = extractReferences("Contact us at admin@domain.md for help");
    assert.deepStrictEqual(refs, []);
  });

  it("ignores mid-line @", () => {
    const refs = extractReferences("see also @other.md for details");
    assert.deepStrictEqual(refs, []);
  });

  it("ignores @path with trailing text on same line", () => {
    const refs = extractReferences("@rules.md some comment");
    assert.deepStrictEqual(refs, []);
  });

  it("matches @ at line start with leading whitespace", () => {
    const refs = extractReferences("   @padded.md");
    assert.deepStrictEqual(refs, ["padded.md"]);
  });

  // ── fenced code blocks ──

  it("ignores @ inside fenced code block", () => {
    const content = [
      "@rules.md",
      "```",
      "@inside-block.md",
      "@also-inside.md",
      "```",
      "@after-block.md",
    ].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, ["rules.md", "after-block.md"]);
  });

  it("handles multiple fenced blocks", () => {
    const content = [
      "@first.md",
      "```py",
      "@hidden1.md",
      "```",
      "@between.md",
      "```",
      "@hidden2.md",
      "```",
      "@last.md",
    ].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, ["first.md", "between.md", "last.md"]);
  });

  it("treats unclosed fenced block as consuming rest", () => {
    const content = ["@before.md", "```", "@hidden.md", "@still-hidden.md"].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, ["before.md"]);
  });

  it("handles empty content", () => {
    const refs = extractReferences("");
    assert.deepStrictEqual(refs, []);
  });

  it("handles content with no references", () => {
    const refs = extractReferences("# Just a normal markdown file\n\nNo references here.");
    assert.deepStrictEqual(refs, []);
  });

  // ── real-world AGENTS.md snippet ──

  it("handles real-world AGENTS.md with mixed content", () => {
    const content = [
      "# Project Rules",
      "",
      "@CODEGRAPH.md",
      "@docs/api-conventions.md",
      "",
      "## Example usage",
      "```",
      "@do-not-resolve.md",
      "@also-ignored.yaml",
      "```",
      "",
      "@~/.agents/CODEGRAPH.md",
      "@/etc/myapp/config.toml",
    ].join("\n");
    const refs = extractReferences(content);
    assert.deepStrictEqual(refs, [
      "CODEGRAPH.md",
      "docs/api-conventions.md",
      "~/.agents/CODEGRAPH.md",
      "/etc/myapp/config.toml",
    ]);
  });
});

// ── recursive resolution integration ───────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-include-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(project: string, relativePath: string, content: string): string {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeConfig(project: string, config: Record<string, unknown>): void {
  writeFile(project, ".pi/settings.json", JSON.stringify({ contextInclude: config }));
}

/** Register the extension against a minimal in-memory pi API and run one scan. */
async function scanIncludes(project: string, rootPath: string, rootContent: string): Promise<string | undefined> {
  let sessionStart: ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined;
  let beforeAgentStart:
    | ((event: {
        systemPrompt?: string;
        systemPromptOptions: { contextFiles: Array<{ path: string; content: string }> };
      }) => Promise<{ systemPrompt: string } | undefined>)
    | undefined;

  contextIncludeExtension({
    on(event: string, handler: unknown) {
      if (event === "session_start") sessionStart = handler as typeof sessionStart;
      if (event === "before_agent_start") beforeAgentStart = handler as typeof beforeAgentStart;
    },
    registerCommand() {},
  } as any);

  assert.ok(sessionStart);
  assert.ok(beforeAgentStart);
  await sessionStart({}, { cwd: project });
  const result = await beforeAgentStart({
    systemPrompt: "base prompt",
    systemPromptOptions: { contextFiles: [{ path: rootPath, content: rootContent }] },
  });
  return result?.systemPrompt;
}

describe("context include recursive resolution", () => {
  it("includes nested references depth-first with their absolute source paths", async () => {
    const project = makeTempProject();
    const root = writeFile(project, "AGENTS.md", "@first.md");
    const first = writeFile(project, "first.md", "first\n@nested.md");
    const nested = writeFile(project, "nested.md", "nested");
    const canonicalFirst = fs.realpathSync(first);
    const canonicalNested = fs.realpathSync(nested);

    const prompt = await scanIncludes(project, root, "@first.md");

    assert.ok(prompt);
    assert.ok(prompt.includes(`<project_instructions path="${canonicalFirst}">\nfirst\n@nested.md\n</project_instructions>`));
    assert.ok(prompt.includes(`<project_instructions path="${canonicalNested}">\nnested\n</project_instructions>`));
    assert.ok(prompt.indexOf(canonicalFirst) < prompt.indexOf(canonicalNested));
  });

  it("terminates cycles without including the same child twice", async () => {
    const project = makeTempProject();
    const root = writeFile(project, "AGENTS.md", "@a.md");
    const a = writeFile(project, "a.md", "A\n@b.md");
    const b = writeFile(project, "b.md", "B\n@a.md");
    const canonicalA = fs.realpathSync(a);
    const canonicalB = fs.realpathSync(b);

    const prompt = await scanIncludes(project, root, "@a.md");

    assert.ok(prompt);
    assert.equal(prompt.split(`<project_instructions path="${canonicalA}">`).length - 1, 1);
    assert.equal(prompt.split(`<project_instructions path="${canonicalB}">`).length - 1, 1);
  });

  it("uses defaults for invalid numeric limits", async () => {
    const project = makeTempProject();
    writeConfig(project, { maxDepth: -1, maxBytes: "not-a-number" });
    const root = writeFile(project, "AGENTS.md", "@first.md");
    const first = writeFile(project, "first.md", "first\n@nested.md");
    const nested = writeFile(project, "nested.md", "nested");

    const prompt = await scanIncludes(project, root, "@first.md");

    assert.ok(prompt?.includes(`<project_instructions path="${fs.realpathSync(first)}">`));
    assert.ok(prompt?.includes(`<project_instructions path="${fs.realpathSync(nested)}">`));
  });

  it("project config block replaces global config before defaults fill gaps", async () => {
    const project = makeTempProject();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-include-agent-"));
    const savedAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = agentDir;
    try {
      fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ contextInclude: { maxDepth: 20, maxBytes: 1 } }),
      );
      fs.writeFileSync(
        path.join(project, ".pi", "settings.json"),
        JSON.stringify({ contextInclude: { maxDepth: 20 } }),
      );

      const root = writeFile(project, "AGENTS.md", "@child.md");
      const child = writeFile(project, "child.md", "included despite global maxBytes");
      const prompt = await scanIncludes(project, root, "@child.md");

      assert.ok(prompt?.includes(`<project_instructions path="${fs.realpathSync(child)}">`));
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = savedAgentDir;
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("enforces maxBytes using UTF-8 bytes rather than JavaScript character count", async () => {
    const project = makeTempProject();
    writeConfig(project, { maxBytes: 1 });
    const root = writeFile(project, "AGENTS.md", "@accent.md");
    const accent = writeFile(project, "accent.md", "é"); // one code point, two UTF-8 bytes
    const canonicalAccent = fs.realpathSync(accent);

    const blocked = await scanIncludes(project, root, "@accent.md");
    assert.equal(blocked, undefined);

    writeConfig(project, { maxBytes: 2 });
    const included = await scanIncludes(project, root, "@accent.md");
    assert.ok(included?.includes(`<project_instructions path="${canonicalAccent}">\né\n</project_instructions>`));
  });
});
