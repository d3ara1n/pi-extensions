import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { paths } from "./paths.ts";

test("production and tests access path and host directory semantics through the shared API", () => {
  const violations: string[] = [];
  const apiFile = paths.join(import.meta.dirname, "paths.ts");
  for (const entry of fs.readdirSync(import.meta.dirname, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = paths.join(entry.parentPath, entry.name);
    if (paths.equals(file, apiFile)) continue;
    const text = fs.readFileSync(paths.toNative(file), "utf8");
    const forbidden = [
      /\b(?:from\s*|(?:import|require)\s*\(\s*|import\s*)["'](?:node:)?(?:path(?:\/(?:posix|win32))?|os)["']/g,
      /\bprocess\s*(?:\.\s*(?:platform|cwd)\b|\[\s*["'](?:platform|cwd)["']\s*\])/g,
    ];
    for (const pattern of forbidden) {
      for (const match of text.matchAll(pattern)) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        if (/^\s*(?:\/\/|\*)/.test(text.slice(lineStart, match.index))) continue;
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${line}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(violations, [], "Use paths.ts instead of host-dependent path operations.");
});
