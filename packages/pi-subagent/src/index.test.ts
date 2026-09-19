/**
 * Regression test for the promptGuidelines cache invalidation bug.
 *
 * pi-coding-agent caches `promptGuidelines` at registerTool time
 * (`_refreshToolRegistry` → `_normalizePromptGuidelines`), so any rebuild
 * after extension load is invisible to the system prompt unless the tool
 * is re-registered. Without re-registration in `session_start`, custom
 * roles defined via `agentOverrides` never appear in the system prompt
 * (AVAILABLE ROLES / DECISION FLOW / CONCRETE EXAMPLES), even though
 * they're callable at runtime. The README's "Agent Overrides" section
 * promises "all descriptions, examples, and decision triggers feed into
 * the LLM's prompt dynamically" — this test guards that promise.
 *
 *   node --test packages/pi-subagent/src/index.test.ts
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentExtension from "./index.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_SUBAGENT_ALLOWED = process.env.PI_SUBAGENT_ALLOWED;

interface CapturedTool {
	name: string;
	promptGuidelines?: string[];
}

interface FakeCtx {
	cwd: string;
	ui: { notify: (message: string, level: string) => void };
	sessionManager: { buildContextEntries: () => unknown[] };
}

function makeFakePi(): {
	pi: ExtensionAPI;
	captured: CapturedTool[];
	sessionStartHandler: ((event: unknown, ctx: FakeCtx) => Promise<void>) | undefined;
} {
	const captured: CapturedTool[] = [];
	let sessionStartHandler:
		| ((event: unknown, ctx: FakeCtx) => Promise<void>)
		| undefined;
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (event === "session_start") {
				sessionStartHandler = handler as (event: unknown, ctx: FakeCtx) => Promise<void>;
			}
		},
		registerTool(tool: CapturedTool) {
			// Snapshot promptGuidelines so initial-vs-reloaded snapshots are
			// independent. Without this, regs[0] and regs[1] would share the
			// same array reference and both reflect the final post-session_start
			// content — making the bug invisible to the test.
			captured.push({
				...tool,
				promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines] : undefined,
			});
		},
		registerMessageRenderer: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMarkdownTransformer: () => undefined,
		registerEntryRenderer: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		appendEntry: () => undefined,
		setSessionName: () => undefined,
		getSessionName: () => undefined,
		setLabel: () => undefined,
		getFlag: () => undefined,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => undefined,
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => undefined,
		unregisterProvider: () => undefined,
		registerProvider: () => undefined,
		registerNativeProvider: () => undefined,
		events: {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		captured,
		get sessionStartHandler() {
			return sessionStartHandler;
		},
	};
}

function delegateRegistrations(captured: CapturedTool[]): CapturedTool[] {
	return captured.filter((t) => t.name === "subagent_delegate");
}

const SAMPLE_CUSTOM_ROLE = {
	role: "default",
	description: "Drafts a tailored Chinese CV for a specific JD",
	examples: ["Adapt CV to a JD", "Rewrite resume bullet points"],
	decisionTrigger: "Need a Chinese CV tailored to a JD?",
	systemPrompt: "You are a CV tailor who rewrites resumes to match a job posting.",
};

interface SetupResult {
	fake: ReturnType<typeof makeFakePi>;
	projectDir: string;
	cleanup: () => void;
}

function setupWithCustomRole(): SetupResult {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-extension-test-"));
	const projectDir = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, ".pi", "settings.json"),
		JSON.stringify({
			subagent: {
				agentOverrides: {
					cv_tailor_drafter: SAMPLE_CUSTOM_ROLE,
				},
			},
		}),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return {
		fake: makeFakePi(),
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

describe("subagent_delegate promptGuidelines cache invalidation", () => {
	after(() => {
		if (ORIGINAL_AGENT_DIR === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
		}
		if (ORIGINAL_SUBAGENT_ALLOWED === undefined) {
			delete process.env.PI_SUBAGENT_ALLOWED;
		} else {
			process.env.PI_SUBAGENT_ALLOWED = ORIGINAL_SUBAGENT_ALLOWED;
		}
	});

	test("initial registration mentions BUILTIN_ROLES but not agentOverrides", () => {
		const { fake, cleanup } = setupWithCustomRole();
		try {
			subagentExtension(fake.pi);

			const regs = delegateRegistrations(fake.captured);
			assert.equal(
				regs.length,
				1,
				"subagent_delegate should be registered once at extension load",
			);
			const initial = regs[0].promptGuidelines ?? [];

			for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
				assert.ok(
					initial.some((g) => g.includes(role.description)),
					`initial promptGuidelines should mention built-in role "${name}"`,
				);
			}
			assert.ok(
				!initial.some((g) => g.includes(SAMPLE_CUSTOM_ROLE.description)),
				"initial promptGuidelines should NOT mention the custom role (session_start not yet emitted)",
			);
		} finally {
			cleanup();
		}
	});

	test("session_start re-registration injects custom role description", async () => {
		const { fake, projectDir, cleanup } = setupWithCustomRole();
		try {
			subagentExtension(fake.pi);

			assert.ok(fake.sessionStartHandler, "session_start handler should be registered");
			await fake.sessionStartHandler(
				{ type: "session_start", reason: "startup" },
				{
					cwd: projectDir,
					ui: { notify: () => undefined },
					sessionManager: { buildContextEntries: () => [] },
				},
			);

			const regs = delegateRegistrations(fake.captured);
			assert.equal(
				regs.length,
				2,
				"subagent_delegate should be registered twice: once at init, once after session_start",
			);

			const reloaded = regs[1].promptGuidelines ?? [];
			const initial = regs[0].promptGuidelines ?? [];

			assert.ok(
				reloaded.some((g) => g.includes(SAMPLE_CUSTOM_ROLE.description)),
				"re-registered promptGuidelines should mention the custom role description",
			);
			assert.ok(
				!initial.some((g) => g.includes(SAMPLE_CUSTOM_ROLE.description)),
				"initial promptGuidelines must remain free of the custom role",
			);
		} finally {
			cleanup();
		}
	});

	test("re-registered promptGuidelines expose decisionTrigger and examples", async () => {
		const { fake, projectDir, cleanup } = setupWithCustomRole();
		try {
			subagentExtension(fake.pi);
			assert.ok(fake.sessionStartHandler, "session_start handler should be registered");
			await fake.sessionStartHandler(
				{ type: "session_start", reason: "startup" },
				{
					cwd: projectDir,
					ui: { notify: () => undefined },
					sessionManager: { buildContextEntries: () => [] },
				},
			);

			const regs = delegateRegistrations(fake.captured);
			const reloaded = regs[regs.length - 1].promptGuidelines ?? [];

			assert.ok(
				reloaded.some((g) => g.includes(SAMPLE_CUSTOM_ROLE.decisionTrigger)),
				"re-registered promptGuidelines should mention the custom role's decisionTrigger",
			);
			assert.ok(
				reloaded.some((g) => g.includes(SAMPLE_CUSTOM_ROLE.examples[0])),
				"re-registered promptGuidelines should mention the custom role's first example",
			);
		} finally {
			cleanup();
		}
	});
});