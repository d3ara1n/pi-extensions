/**
 * Session initialization must register tools only after loading project roles.
 *
 *   node --test packages/pi-subagent/src/index.test.ts
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "./index.ts";
import { BUILTIN_ROLES } from "./roles.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAllowedRoles = process.env.PI_SUBAGENT_ALLOWED;
const tempRoots: string[] = [];
const TOOL_NAMES = [
  "subagent_delegate",
  "subagent_wait",
  "subagent_check",
  "subagent_steer",
  "subagent_cancel",
];
const customRole = {
  role: "default",
  description: "Drafts a tailored CV",
  examples: ["Adapt a CV to a job description"],
  decisionTrigger: "Need a tailored CV?",
  systemPrompt: "Draft a tailored CV.",
};

interface CapturedTool {
  name: string;
  promptGuidelines?: string[];
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-init-test-"));
  tempRoots.push(root);
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.PI_SUBAGENT_ALLOWED;

  const tools: CapturedTool[] = [];
  let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      if (event === "session_start") sessionStart = handler;
    },
    registerTool(tool: CapturedTool) {
      tools.push({
        name: tool.name,
        promptGuidelines: tool.promptGuidelines && [...tool.promptGuidelines],
      });
    },
    registerMessageRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  subagentExtension(pi);

  return {
    tools,
    projectDir,
    agentDir: path.join(root, "agent"),
    async start(agentOverrides: Record<string, unknown> = {}) {
      fs.writeFileSync(
        path.join(projectDir, ".pi", "settings.json"),
        JSON.stringify({ subagent: { agentOverrides } }),
      );
      assert.ok(sessionStart);
      await sessionStart(
        { type: "session_start", reason: "startup" },
        { cwd: projectDir, ui: { notify() {} } },
      );
    },
  };
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalAllowedRoles === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
  else process.env.PI_SUBAGENT_ALLOWED = originalAllowedRoles;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subagent tool registration", () => {
  test("registers all tools once after loading session configuration", async () => {
    const harness = setup();
    assert.equal(harness.tools.length, 0);

    await harness.start({
      researcher: { disabled: true },
      cv_tailor: customRole,
    });

    assert.deepEqual(harness.tools.map((tool) => tool.name), TOOL_NAMES);
    const guidelines = harness.tools[0].promptGuidelines?.join("\n") ?? "";
    assert.match(guidelines, /  - cv_tailor: Drafts a tailored CV/);
    assert.ok(guidelines.includes(customRole.decisionTrigger));
    assert.ok(guidelines.includes(customRole.examples[0]));
    assert.ok(!guidelines.includes(`  - researcher: ${BUILTIN_ROLES.researcher.description}`));
    assert.ok(!guidelines.includes(`subagent_delegate(researcher):`));
    for (const tool of harness.tools.slice(1)) {
      assert.equal(tool.promptGuidelines, undefined);
    }
  });

  test("starts with built-in roles when there are no overrides", async () => {
    const harness = setup();
    await harness.start();

    const guidelines = harness.tools[0].promptGuidelines?.join("\n") ?? "";
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      assert.ok(guidelines.includes(`  - ${name}: ${role.description}`));
    }
  });

  test("repeated session starts replace roles instead of retaining stale guidelines", async () => {
    const harness = setup();
    await harness.start({ researcher: { disabled: true }, cv_tailor: customRole });
    const first = harness.tools[0].promptGuidelines?.join("\n") ?? "";

    await harness.start({ worker: { description: "Customized worker" } });
    assert.deepEqual(harness.tools.slice(5).map((tool) => tool.name), TOOL_NAMES);
    const second = harness.tools[5].promptGuidelines?.join("\n") ?? "";
    assert.ok(first.includes(customRole.description));
    assert.ok(!second.includes(customRole.description));
    assert.ok(second.includes("  - worker: Customized worker"));
    assert.ok(second.includes(`  - researcher: ${BUILTIN_ROLES.researcher.description}`));
  });

  test("the framework builds the effective system prompt from session roles", async () => {
    const { projectDir, agentDir } = setup();
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({
        subagent: { agentOverrides: { researcher: { disabled: true }, cv_tailor: customRole } },
      }),
    );
    const loader = new DefaultResourceLoader({
      cwd: projectDir,
      agentDir,
      extensionFactories: [subagentExtension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd: projectDir,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(projectDir),
    });
    try {
      assert.deepEqual(extensionsResult.errors, []);
      assert.equal(session.getActiveToolNames().includes("subagent_delegate"), false);
      await session.bindExtensions({ mode: "print" });

      assert.deepEqual(
        session.getActiveToolNames().filter((name) => name.startsWith("subagent_")),
        TOOL_NAMES,
      );
      assert.ok(session.systemPrompt.includes(`- cv_tailor: ${customRole.description}`));
      assert.ok(session.systemPrompt.includes(customRole.decisionTrigger));
      assert.ok(session.systemPrompt.includes(customRole.examples[0]));
      assert.ok(!session.systemPrompt.includes(`- researcher: ${BUILTIN_ROLES.researcher.description}`));
    } finally {
      session.dispose();
    }
  });
});
