import { describe, it } from "node:test";
import * as assert from "node:assert";
import { extractReferences } from "./index.ts";

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
		assert.deepStrictEqual(refs, ["file.md", "file.txt", "file.yaml", "file.yml", "file.json", "file.toml"]);
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
		const content = [
			"@before.md",
			"```",
			"@hidden.md",
			"@still-hidden.md",
		].join("\n");
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
