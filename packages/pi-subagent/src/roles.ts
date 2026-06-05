/**
 * Built-in subagent role definitions.
 */

import type { SubagentRole } from "./types.ts";

/**
 * Predefined subagent roles. Each maps to a pi-model-roles role
 * and has a tailored system prompt and tool set.
 */
export const BUILTIN_ROLES: Record<string, SubagentRole> = {
  explorer: {
    role: "fast",
    tools: ["read", "bash", "find", "grep", "glob"],
    systemPrompt:
      "You are a fast code explorer. Read files, search patterns, map dependencies. Do NOT edit any files. Report findings concisely.",
  },
  reviewer: {
    role: "heavy",
    tools: ["read", "bash", "grep", "glob"],
    systemPrompt:
      "You are a senior code reviewer. Inspect code for correctness, maintainability, security issues. Do NOT edit files. Provide evidence-backed findings with file/line references.",
  },
  worker: {
    role: "default",
    tools: ["read", "bash", "edit", "write", "grep", "glob"],
    systemPrompt:
      "You are an implementation worker. Follow the given plan precisely. Make minimal, focused changes. Report what you changed and what validation you ran.",
  },
  researcher: {
    role: "fast",
    tools: ["web_search", "fetch_content", "read"],
    systemPrompt:
      "You are a web researcher. Find relevant documentation, examples, and best practices. Return concise summaries with source links.",
  },
};
