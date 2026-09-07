"use strict";
// Recall fires on machine-generated turns — closed.
//
// WHY THIS EXISTS. Measured on the real recall log (bench/machine_turn_injection.js,
// 2658+ turns across recall_log.jsonl + .jsonl.1): machine-generated queries
// (<task-notification>, <cross-session-message>, ...) got injected on ~67% of
// turns versus ~39% for real user turns — nearly double — because a task
// notification is long and keyword-rich, not because it is a question anyone
// asked. `NOISE_GATE_CLASSES` in low_signal.js only ever gated the WRITE side
// (what auto-capture refuses to store); nothing gated the QUERY side, so a
// machine turn searched memory and injected it exactly like a human prompt would.
//
// This file pins the READ-side predicate (`isMachineTurn`) and its two call
// sites (recall(), recallAsync()): a machine-shaped query must inject an empty
// `<memory-context>` while the SAME keyword content without the machine prefix
// still injects, proving the gate is prefix-shaped, not keyword-shaped. It must
// also keep logging the turn (recall_log.jsonl), because a gate that stops
// logging stops being measurable.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { isMachineTurn, MACHINE_TURN_PREFIXES } = require("../scripts/low_signal.js");
const { MemoryStore } = require("../scripts/memory_store.js");

const RECALL_JS = path.join(__dirname, "..", "scripts", "memory_recall.js");
const LOG_FILE = "recall_log.jsonl";

function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-machine-turn-"));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const baseDir = (home) => path.join(home, ".memory-tencentdb");
const logPath = (home) => path.join(baseDir(home), LOG_FILE);

const MARKER = "ZEBRAFACTOR the deploy pipeline uses canary rollout";

/** Seed a global store with one FTS-searchable atom the keyword "ZEBRAFACTOR" hits. */
function seedStore(home) {
  const global = path.join(baseDir(home), "global");
  fs.mkdirSync(path.join(global, "records"), { recursive: true });
  const store = new MemoryStore(path.join(global, "index.db"));
  store.upsert({ id: "m_zebra01", content: MARKER, type: "instruction", priority: 60 });
  store.close();
  return home;
}

const env = (home, extra) => ({
  ...process.env, HOME: home, USERPROFILE: home, MEMORY_TENCENTDB_HOME: baseDir(home), ...extra,
});

function readLog(home) {
  const raw = fs.readFileSync(logPath(home), "utf-8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
}

function runSyncRecall(home, query) {
  return execFileSync("node", ["-e",
    `const { recall, RECALL_SOURCE } = require(${JSON.stringify(RECALL_JS)});
     process.stdout.write(recall(${JSON.stringify(query)}, "", 280, 5, RECALL_SOURCE.HOOK) || "");`],
    { env: env(home), encoding: "utf-8" });
}

function runAsyncRecall(home, query) {
  return execFileSync("node", ["-e",
    `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL_JS)});
     const unit = () => { const v = new Float32Array(8); v[0] = 1; return v; };
     const embedFn = async () => ({ vector: unit(), reason: "ready" });
     recallAsync(${JSON.stringify(query)}, "", 280, 5, RECALL_SOURCE.HOOK, { embedFn })
       .then((out) => { process.stdout.write(out || ""); });`],
    { env: env(home), encoding: "utf-8" });
}

// ── isMachineTurn unit tests ─────────────────────────────────────────────

test("isMachineTurn matches all 8 canonical prefixes, with and without leading whitespace", () => {
  for (const prefix of MACHINE_TURN_PREFIXES) {
    assert.equal(isMachineTurn(`${prefix}>\nsome body`), true, `bare: ${prefix}`);
    assert.equal(isMachineTurn(`   \n${prefix}>\nsome body`), true, `whitespace-led: ${prefix}`);
  }
});

test("isMachineTurn matches an attributed variant that never closes before content", () => {
  // The real wire shape for cross-session-message and command-message: attributes
  // before the closing `>`, sometimes never closing before the content resumes.
  assert.equal(
    isMachineTurn('<cross-session-message from="uds:/run/x" from-name="y" from-mode="bypass">hi'),
    true,
  );
  assert.equal(
    isMachineTurn("<command-message>astral:uv</command-message>\n<command-name>/astral:uv</command-name>"),
    true,
  );
});

test("isMachineTurn is false for plain user text", () => {
  assert.equal(isMachineTurn("how do I configure the vector index?"), false);
  assert.equal(isMachineTurn("ok push và tạo pr and merge main đi"), false);
});

test("isMachineTurn is false when a tag merely appears mid-string, not as a prefix", () => {
  assert.equal(isMachineTurn("please summarize this: <command-message>foo</command-message>"), false);
});

test("isMachineTurn is false for empty/non-string input, mirroring classifyLowSignal's coercion", () => {
  assert.equal(isMachineTurn(""), false);
  assert.equal(isMachineTurn(null), false);
  assert.equal(isMachineTurn(undefined), false);
});

// ── recall() (sync) ──────────────────────────────────────────────────────

test("a machine-shaped query injects nothing from recall(), for all 8 prefixes", () => {
  withFakeHome((home) => {
    seedStore(home);
    for (const prefix of MACHINE_TURN_PREFIXES) {
      const query = `${prefix}>\nZEBRAFACTOR canary status: pass`;
      const out = runSyncRecall(home, query);
      assert.equal(out, "", `recall() must return "" for machine prefix ${prefix}`);
    }
  });
});

test("the identical keyword content WITHOUT a machine prefix still injects", () => {
  withFakeHome((home) => {
    seedStore(home);
    const out = runSyncRecall(home, "ZEBRAFACTOR canary status: pass");
    assert.ok(out.includes(MARKER), `human query must still inject the matched atom:\n${out}`);
  });
});

test("a machine turn still appends exactly one recall_log.jsonl row, query verbatim, zero injection", () => {
  withFakeHome((home) => {
    seedStore(home);
    const query = "<task-notification>\nZEBRAFACTOR canary status: pass";
    const out = runSyncRecall(home, query);
    assert.equal(out, "");
    const rows = readLog(home);
    assert.equal(rows.length, 1, "exactly one row logged for the one machine-turn call");
    assert.equal(rows[0].query, query, "query is logged verbatim");
    assert.deepEqual(rows[0].injectedIds, []);
    assert.deepEqual(rows[0].injectedFactIds, []);
    assert.deepEqual(rows[0].droppedIds, []);
    assert.equal(rows[0].chars, 0);
  });
});

// ── recallAsync() ─────────────────────────────────────────────────────────

test("recallAsync gates a machine turn the same way, and still logs it", () => {
  withFakeHome((home) => {
    seedStore(home);
    const query = "<cross-session-message from=\"x\">\nZEBRAFACTOR canary status: pass";
    const out = runAsyncRecall(home, query);
    assert.equal(out, "");
    const rows = readLog(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query, query);
    assert.deepEqual(rows[0].injectedIds, []);
    assert.deepEqual(rows[0].injectedFactIds, []);
    assert.deepEqual(rows[0].droppedIds, []);
    assert.equal(rows[0].chars, 0);
  });
});

test("recallAsync still injects for the identical content without the machine prefix", () => {
  withFakeHome((home) => {
    seedStore(home);
    const out = runAsyncRecall(home, "ZEBRAFACTOR canary status: pass");
    assert.ok(out.includes(MARKER), `human query must still inject via recallAsync:\n${out}`);
  });
});
