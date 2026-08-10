"use strict";
// `tmem consolidate-context` — one call that bundles the consolidator's whole read
// phase (status + scenes + atoms delta + persona + doctrine + changelog). Replaces
// 5-6 separate `tmem` invocations, each of which was a separate LLM round-trip.
//
//  #1 returns every section, shapes correct
//  #2 atoms are the DELTA since the per-project watermark (not the whole pool)
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ctx-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ctx-proj-"));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  return { home, proj };
}
function seedStore(dir, atoms) {
  fs.mkdirSync(dir, { recursive: true });
  const store = new MemoryStore(path.join(dir, "index.db"));
  for (const a of atoms) store.upsert({ id: a.id, content: a.content, type: a.type || "episodic", createdAt: a.ts, updatedAt: a.ts });
  store.close();
}
function run(cmd, home, proj, input) {
  return execFileSync("node", [CLI, ...cmd], {
    encoding: "utf-8", input,
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
}

const T1 = "2026-01-01T00:00:00.000Z", T2 = "2026-02-01T00:00:00.000Z", T3 = "2026-03-01T00:00:00.000Z", T4 = "2026-04-01T00:00:00.000Z";

test("#1 consolidate-context bundles all sections in one call", () => {
  const { home, proj } = tmpEnv();
  const hash = projectHashForCwd(proj);
  const base = path.join(home, ".memory-tencentdb");
  seedStore(path.join(base, "projects", hash), [
    { id: "p1", content: "project atom one", ts: T1 },
    { id: "p2", content: "project atom two", ts: T2 },
  ]);
  seedStore(path.join(base, "global"), [{ id: "g1", content: "global persona atom", type: "persona", ts: T1 }]);
  run(["write-scene", "--name", "Alpha", "--summary", "alpha scene", "--heat", "3"], home, proj, "## Key Facts\n- fact");
  run(["write-persona", "--scope", "project"], home, proj, "# Team Operating Doctrine\n## Core Principles\n- Keep tests green before merge.\n");

  const out = JSON.parse(run(["consolidate-context"], home, proj));
  assert.strictEqual(out.project_hash, hash);
  assert.strictEqual(out.status.project.total, 2, "project total count");
  assert.strictEqual(out.status.global.total, 1, "global total count");
  assert.ok(Array.isArray(out.scenes) && out.scenes.length >= 1, "scenes listed");
  assert.strictEqual((out.atoms.project || []).length, 2, "project atoms delta");
  assert.strictEqual((out.atoms.global || []).length, 1, "global atoms delta");
  assert.ok(out.persona.project.includes("Operating Doctrine"), "project doctrine present");
  assert.ok(Array.isArray(out.changelog), "changelog array present");
});

test("#2 atoms respect the per-project watermark (delta, not whole pool)", () => {
  const { home, proj } = tmpEnv();
  const hash = projectHashForCwd(proj);
  const base = path.join(home, ".memory-tencentdb");
  seedStore(path.join(base, "projects", hash), [
    { id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T2 }, { id: "c", content: "three", ts: T3 },
  ]);
  // Cold start: no watermark → whole pool.
  let out = JSON.parse(run(["consolidate-context"], home, proj));
  assert.strictEqual((out.atoms.project || []).length, 3, "cold start = full pool");
  assert.strictEqual(out.watermark, null);

  run(["mark-done"], home, proj);                       // watermark → T3
  seedStore(path.join(base, "projects", hash), [{ id: "d", content: "four", ts: T4 }]);
  out = JSON.parse(run(["consolidate-context"], home, proj));
  const ids = (out.atoms.project || []).map((r) => r.record_id || r.id).sort();
  assert.deepStrictEqual(ids, ["d"], "after mark-done only the new atom is in scope");
  assert.strictEqual(out.watermark, T3, "watermark reported");
});
