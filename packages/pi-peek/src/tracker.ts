/**
 * Tracker — live snapshot of the local main agent.
 *
 * Module-level state is fine here: tracker is read via getMainAgentStatus()
 * (which returns a copy), so no globalThis is needed. Consumers like
 * pi-peek-agent's PeerInfo snapshot call that getter — they never touch this
 * module's state directly, so there's no module-identity hazard.
 */

import type { MainAgentStatus } from "./types.ts";

let status: MainAgentStatus = {
  activity: "idle",
  toolIndex: 0,
  turn: 0,
  lastUpdated: nowIso(),
};

function nowIso(): string {
  return new Date().toISOString();
}

export function getMainAgentStatus(): MainAgentStatus {
  return { ...status };
}

export function onTurnStart(turnIndex: number): void {
  status = {
    activity: "thinking",
    toolIndex: 0,
    turn: turnIndex,
    lastUpdated: nowIso(),
  };
}

export function onTurnEnd(_turnIndex: number): void {
  status = {
    ...status,
    activity: "idle",
    lastUpdated: nowIso(),
  };
}

export function onToolStart(toolName: string, args: any): void {
  const detail = formatToolActivity(toolName, args);
  status = {
    activity: detail ? `${toolName}: ${detail}` : `executing ${toolName}`,
    toolName,
    toolIndex: status.toolIndex + 1,
    turn: status.turn,
    lastUpdated: nowIso(),
  };
}

export function onToolEnd(toolName: string): void {
  if (status.toolName !== toolName) {
    status = { ...status, lastUpdated: nowIso() };
    return;
  }
  status = {
    ...status,
    activity: "thinking",
    toolName: undefined,
    lastUpdated: nowIso(),
  };
}

function formatToolActivity(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  if (name === "bash" && typeof args.command === "string") {
    return args.command.split("\n")[0]!.slice(0, 80);
  }
  if ((name === "read" || name === "write" || name === "edit") && typeof args.path === "string") {
    return args.path;
  }
  return "";
}
