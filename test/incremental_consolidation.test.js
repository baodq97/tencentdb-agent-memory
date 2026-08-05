"use strict";
// Incremental consolidation (upstream CheckpointManager parity) — the L1→L2/L3
// read must be scoped to the DELTA since the last consolidation, not the whole
// pool. Upstream keys this on a `last_extraction_updated_time` cursor; here the
// cursor is `state.projects[<hash>].last_consolidated` (already written by
// updateState, previously read by nobody). Three behaviours:
//   #1 `tmem atoms project --since <ts>` returns only records updated_time > ts
//   #2 `tmem mark-done` advances the watermark to max(updated_time) processed
//   #3 `tmem atoms project --since-last` reads that watermark (full on cold start)
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");
const { MemoryStore } = require("../scripts/memory_store.js");

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-inc-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-inc-proj-"));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  return { home, proj };
}

// Seed the project store with atoms at controlled updated_time values.
function seed(home, proj, atoms) {
  const hash = projectHashForCwd(proj);
  const dir = path.join(home, ".memory-tencentdb", "projects", hash);
  fs.mkdirSync(dir, { recursive: true });
  const store = new MemoryStore(path.join(dir, "index.db"));
  for (const a of atoms) {
    store.upsert({ id: a.id, content: a.content, type: a.type || "episodic",
      createdAt: a.ts, updatedAt: a.ts });
  }
  store.close();
  return hash;
}

function atoms(args, home, proj) {
  const out = execFileSync("node", [CLI, "atoms", ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  return JSON.parse(out);
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";
const T4 = "2026-04-01T00:00:00.000Z";

test("#1 atoms --since scopes the read to the delta (not the whole pool)", () => {
  const { home, proj } = tmpEnv();
  seed(home, proj, [
    { id: "a", content: "first atom", ts: T1 },
    { id: "b", content: "second atom", ts: T2 },
    { id: "c", content: "third atom", ts: T3 },
  ]);
  const res = atoms(["project", "--since", T2], home, proj);
  const ids = (res.project || []).map((r) => r.record_id || r.id).sort();
  assert.deepStrictEqual(ids, ["c"], "only records updated after T2 should return");
});

test("#2 mark-done advances the per-project watermark to max(updated_time)", () => {
  const { home, proj } = tmpEnv();
  const hash = seed(home, proj, [
    { id: "a", content: "first atom", ts: T1 },
    { id: "b", content: "second atom", ts: T2 },
    { id: "c", content: "third atom", ts: T3 },
  ]);
  execFileSync("node", [CLI, "mark-done"], {
    encoding: "utf-8", env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  const state = JSON.parse(fs.readFileSync(path.join(home, ".memory-tencentdb", "state.json"), "utf-8"));
  assert.strictEqual(state.projects[hash].last_consolidated, T3);
});

test("#3 atoms --since-last reads the watermark; full pool on cold start", () => {
  const { home, proj } = tmpEnv();
  seed(home, proj, [
    { id: "a", content: "first atom", ts: T1 },
    { id: "b", content: "second atom", ts: T2 },
    { id: "c", content: "third atom", ts: T3 },
  ]);
  // Cold start: no watermark yet → falls back to the full pool.
  const cold = atoms(["project", "--since-last"], home, proj);
  assert.strictEqual((cold.project || []).length, 3, "cold start returns the full pool");

  // Consolidate → watermark advances to T3.
  execFileSync("node", [CLI, "mark-done"], {
    encoding: "utf-8", env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  // A new atom arrives after consolidation.
  seed(home, proj, [{ id: "d", content: "fourth atom", ts: T4 }]);
  const delta = atoms(["project", "--since-last"], home, proj);
  const ids = (delta.project || []).map((r) => r.record_id || r.id).sort();
  assert.deepStrictEqual(ids, ["d"], "after consolidation only the new atom is in scope");
});
