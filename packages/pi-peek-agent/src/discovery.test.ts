/**
 * Regression tests for registry marker validation and registry path expansion.
 * Run: node --test packages/pi-peek-agent/src/discovery.test.ts
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listPeersFromRegistry, resolveRegistryDir } from "./discovery.ts";

let registryDir = "";

function peer(sessionId: string) {
  return {
    sessionId,
    pid: 12345,
    sockPath: "/tmp/peek-test.sock",
    name: "test-peer",
    cwd: "/project",
    model: "provider/model",
    since: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
  };
}

function writeMarker(fileName: string, value: unknown): void {
  fs.writeFileSync(path.join(registryDir, fileName), JSON.stringify(value));
}

beforeEach(() => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-registry-"));
});

afterEach(() => {
  fs.rmSync(registryDir, { recursive: true, force: true });
});

test("listPeersFromRegistry rejects traversal ids and filename/identity mismatches", () => {
  writeMarker("valid-peer.json", peer("valid-peer"));
  writeMarker("wrong-name.json", peer("different-id"));
  writeMarker("traversal.json", peer("../escape"));
  writeMarker("dotdot.json", peer(".."));
  writeMarker("not-json.json", "this is not valid JSON");

  const peers = listPeersFromRegistry(registryDir, "self");
  assert.equal(peers.length, 1);
  assert.equal(peers[0]!.sessionId, "valid-peer");
  assert.equal(peers[0]!.markerFile, path.join(registryDir, "valid-peer.json"));
});

test("listPeersFromRegistry excludes self and permits safe session-id characters", () => {
  writeMarker("self.json", peer("self"));
  writeMarker("Peer_01-abc.json", peer("Peer_01-abc"));

  const peers = listPeersFromRegistry(registryDir, "self");
  assert.deepEqual(peers.map((item) => item.sessionId), ["Peer_01-abc"]);
});

test("resolveRegistryDir expands only leading home shorthand", () => {
  const home = os.homedir();
  assert.equal(resolveRegistryDir("~"), home);
  assert.equal(resolveRegistryDir("~/peek-registry"), path.join(home, "peek-registry"));
  assert.equal(resolveRegistryDir(`~${path.sep}peek-registry`), path.join(home, "peek-registry"));
  assert.equal(resolveRegistryDir("/tmp/~not-home"), "/tmp/~not-home");
});
