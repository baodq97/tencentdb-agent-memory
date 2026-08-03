"use strict";
// Append-only READ log for recall.
//
// WHY IT EXISTS. Every WRITE is logged twice — `<store>/changelog.jsonl` and
// `records/*.jsonl` — and no READ was logged anywhere. So "which memories does
// the agent ever actually use" was unanswerable, and ranking had no feedback term
// available even in principle. `droppedIds` is the half that could not be
// recovered after the fact: candidates that ranked high enough to be considered
// and were then discarded for not fitting the char budget, silently.
//
// THE HARD CONSTRAINT is the last test in this file: recall runs on the
// UserPromptSubmit hot path behind an 8s hook timeout, so a log that cannot be
// written must cost the user nothing. Returning context matters more than
// recording that we did.
//
// Every test here runs against a temp HOME. Nothing touches ~/.memory-tencentdb.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RECALL = path.join(__dirname, "..", "scripts", "memory_recall.js");
const HOOK = path.join(__dirname, "..", "hooks", "scripts", "on_user_prompt.js");
const PLUGIN_ROOT = path.join(__dirname, "..");

const LOG_FILE = "recall_log.jsonl";

function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-recall-log-"));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const baseDir = (home) => path.join(home, ".memory-tencentdb");
const logPath = (home) => path.join(baseDir(home), LOG_FILE);

/**
 * Enough store for recall() to return a non-empty block without needing
 * node:sqlite: the persona alone makes `<memory-context>` non-empty, and a scene
 * gives the nav block something to render.
 */
function seedStore(home) {
  const global = path.join(baseDir(home), "global");
  fs.mkdirSync(path.join(global, "scene_blocks"), { recursive: true });
  fs.writeFileSync(path.join(global, "persona.md"),
    "# User Persona\n\n## Preferences\n- Always answer concisely and in the user's language.\n",
    "utf-8");
  fs.writeFileSync(path.join(global, "scene_blocks", "vector-index-sync.md"),
    "-----META-START-----\ncreated: 2026-01-01T00:00:00.000Z\n" +
    "updated: 2026-01-02T00:00:00.000Z\nsummary: sqlite-vec embedding sync\nheat: 5\n" +
    "-----META-END-----\n\nbody\n", "utf-8");
  return home;
}

const env = (home, extra) => ({
  ...process.env, HOME: home, USERPROFILE: home, ...extra,
});

function runCli(home, query) {
  return execFileSync("node", [RECALL, "recall", "--query", query], {
    env: env(home), encoding: "utf-8",
  });
}

function runHook(home, prompt, cwd) {
  return execFileSync("node", [HOOK], {
    env: env(home, { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }),
    input: JSON.stringify({ prompt, cwd: cwd || "/work/alpha" }),
    encoding: "utf-8",
  });
}

function readLog(home) {
  const raw = fs.readFileSync(logPath(home), "utf-8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
}

test("recall writes one JSONL line to the memory root, beside the existing logs", () => {
  withFakeHome((home) => {
    seedStore(home);
    runCli(home, "sqlite-vec embedding sync");

    const rows = readLog(home);
    assert.equal(rows.length, 1, "exactly one line per recall");
    const [row] = rows;
    assert.deepEqual(Object.keys(row).sort(),
      ["at", "chars", "droppedIds", "injectedIds", "query", "source"]);
    assert.ok(!Number.isNaN(Date.parse(row.at)));
    assert.ok(Array.isArray(row.injectedIds));
    assert.ok(Array.isArray(row.droppedIds));
    assert.equal(typeof row.chars, "number");
  });
});

test("the log is append-only: a second recall adds a line, it does not replace one", () => {
  withFakeHome((home) => {
    seedStore(home);
    runCli(home, "first query");
    runCli(home, "second query");

    const rows = readLog(home);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.query), ["first query", "second query"]);
  });
});

test("query is stored VERBATIM — a truncated query cannot be re-run offline", () => {
  withFakeHome((home) => {
    seedStore(home);
    // Long, punctuated, non-ASCII: nothing about it may be normalised away.
    const q = "tại sao vector embeddings bị orphaned trong sqlite-vec? " + "x".repeat(400);
    runCli(home, q);
    assert.equal(readLog(home)[0].query, q);
    // records/*.jsonl already stores full prompts, so this is no new exposure —
    // the point of the assertion is that nobody "helpfully" adds a cap later.
  });
});

test("source distinguishes the automatic hook path from an explicit CLI search", () => {
  withFakeHome((home) => {
    seedStore(home);
    runCli(home, "from the terminal");
    runHook(home, "from the prompt hook");

    const rows = readLog(home);
    assert.equal(rows.length, 2, "both callers must log, and neither may log twice");
    assert.deepEqual(rows.map((r) => r.source), ["cli", "hook"]);
    // The two callers pass identical arguments — `(query, projectHash)` — so the
    // distinction cannot come from the call site. It comes from the entry point.
    assert.equal(rows[1].query, "from the prompt hook");
  });
});

test("a recall that returned nothing is still logged — that is the interesting row", () => {
  withFakeHome((home) => {
    // No persona, no scenes, no index.db: recall() returns "".
    fs.mkdirSync(path.join(baseDir(home), "global"), { recursive: true });
    const out = runCli(home, "nothing to find here");
    assert.match(out, /no relevant memories/);

    const rows = readLog(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chars, 0);
    assert.deepEqual(rows[0].injectedIds, []);
    assert.deepEqual(rows[0].droppedIds, []);
  });
});

test("chars matches the block that was actually injected", () => {
  withFakeHome((home) => {
    seedStore(home);
    const out = execFileSync("node",
      [RECALL, "recall", "--query", "sqlite-vec embedding sync", "--format", "json"],
      { env: env(home), encoding: "utf-8" });
    assert.equal(readLog(home)[0].chars, JSON.parse(out).chars);
  });
});

test("droppedIds records the candidates the budget discarded, not just the survivors", () => {
  // Exercised in-process against the shared renderer rather than through a
  // seeded store: what is under test is the accounting rule (every candidate
  // lands in exactly one of the two lists), and building a store big enough to
  // overflow the atom pool would pin FTS ranking instead.
  const { renderMemories } = requireRecallInternals();
  const mem = (id, chars) => ({ record_id: id, type: "episodic", content: "y".repeat(chars) });

  const out = renderMemories([mem("m_1", 50), mem("m_2", 500), mem("m_3", 40)], 120);
  assert.deepEqual(out.injectedIds, ["m_1", "m_3"]);
  assert.deepEqual(out.droppedIds, ["m_2"], "the oversized atom is recorded, not silently dropped");
  // Skip, don't break: m_3 ranked BEHIND the atom that did not fit and is still
  // injected. That is why droppedIds is a set and not simply "the tail".
  assert.ok(out.text.startsWith("<memories>"));
  assert.equal(out.text.split("\n").filter((l) => l.startsWith("- ")).length, 2);
});

test("every candidate lands in exactly one list", () => {
  const { renderMemories } = requireRecallInternals();
  const mem = (id, chars) => ({ record_id: id, type: "fact", content: "z".repeat(chars) });
  const candidates = [mem("a", 300), mem("b", 20), mem("c", 300), mem("d", 20)];
  const out = renderMemories(candidates, 100);
  assert.deepEqual(
    [...out.injectedIds, ...out.droppedIds].sort(),
    candidates.map((m) => m.record_id).sort());
});

test("a log write failure does not break recall", () => {
  withFakeHome((home) => {
    seedStore(home);
    // The most direct way to make the append fail without breaking anything
    // else: put a DIRECTORY where the log file belongs. mkdir of the parent
    // still succeeds, appendFileSync raises EISDIR.
    fs.mkdirSync(logPath(home), { recursive: true });

    const out = runCli(home, "sqlite-vec embedding sync");
    assert.match(out, /<memory-context>/, "recall must still return its context");
    assert.match(out, /<scene-navigation>/);
    assert.ok(fs.statSync(logPath(home)).isDirectory(), "and must not have clobbered the obstruction");
  });
});

test("a read-only memory root does not break recall either", { skip: isRoot() }, () => {
  withFakeHome((home) => {
    seedStore(home);
    const dir = baseDir(home);
    fs.chmodSync(dir, 0o555);
    try {
      const out = runCli(home, "sqlite-vec embedding sync");
      assert.match(out, /<memory-context>/);
      assert.equal(fs.existsSync(logPath(home)), false, "nothing was written, and nothing threw");
    } finally {
      fs.chmodSync(dir, 0o755); // so the fixture can be cleaned up
    }
  });
});

/**
 * memory_recall.js pulls in memory_store.js -> node:sqlite at require time, which
 * is fine in-process here (unlike view/transform.js, which is pure by test).
 * Required lazily so the module is only loaded by the tests that need it and the
 * subprocess tests above stay the only ones that can touch a filesystem.
 */
function requireRecallInternals() {
  return require("../scripts/memory_recall.js");
}

/** chmod cannot deny root, so the permission test would silently pass. */
function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
