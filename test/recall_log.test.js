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

test("the visualiser's /api/recall probe logs as 'view', so it never inflates hit rate", () => {
  withFakeHome((home) => {
    seedStore(home);
    // The server calls recallAsync(..., RECALL_SOURCE.VIEW); drive that same entry
    // point directly rather than standing up the HTTP server for one field.
    execFileSync("node", ["-e",
      `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL)});
       recallAsync("sqlite-vec embedding sync", "", 280, 5, RECALL_SOURCE.VIEW).then(() => process.exit(0));`],
      { env: env(home), encoding: "utf-8" });

    const rows = readLog(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "view");
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

/* ── rotation ──────────────────────────────────────────────────────────
 * Unrotated, this file grows 35-50 KB/day of verbatim prompts (~15 MB/year) and
 * nothing prunes it. These pin the bound, not the exact size: read the threshold
 * from the module so raising it stays a one-line change.
 */

const { RECALL_LOG_MAX_BYTES } = requireRecallInternals();

/** A single valid JSONL line of exactly `bytes` bytes including its newline. */
function filler(bytes) {
  const line = JSON.stringify({ filler: true, pad: "" });
  const pad = "x".repeat(bytes - line.length - 1);
  return JSON.stringify({ filler: true, pad }) + "\n";
}

function seedLog(home, bytes) {
  fs.mkdirSync(baseDir(home), { recursive: true });
  fs.writeFileSync(logPath(home), filler(bytes), "utf-8");
}

test("a log at the threshold is rotated to .1, and the new line starts a fresh file", () => {
  withFakeHome((home) => {
    seedStore(home);
    seedLog(home, RECALL_LOG_MAX_BYTES);

    runCli(home, "sqlite-vec embedding sync");

    const rotated = logPath(home) + ".1";
    assert.equal(fs.statSync(rotated).size, RECALL_LOG_MAX_BYTES,
      "the old log is moved aside intact, not truncated in place");
    const rows = readLog(home);
    assert.equal(rows.length, 1, "the live log now holds only the recall that triggered rotation");
    assert.equal(rows[0].query, "sqlite-vec embedding sync",
      "and the entry that triggered it is not the one that gets lost");
  });
});

test("a log below the threshold is left alone — rotation is size-based, not per-call", () => {
  withFakeHome((home) => {
    seedStore(home);
    seedLog(home, RECALL_LOG_MAX_BYTES - 1024);

    runCli(home, "first");
    runCli(home, "second");

    assert.equal(fs.existsSync(logPath(home) + ".1"), false);
    assert.equal(readLog(home).length, 3, "filler + both recalls");
  });
});

test("exactly ONE generation is kept: a second rotation replaces .1, it does not create .2", () => {
  withFakeHome((home) => {
    seedStore(home);
    seedLog(home, RECALL_LOG_MAX_BYTES);
    runCli(home, "rotation one");
    // Re-fill and rotate again. The first generation is expected to be GONE:
    // this log is bounded on purpose (ceiling = 2 x threshold), it is not an
    // archive, and a .1/.2/.3 cascade was rejected deliberately.
    seedLog(home, RECALL_LOG_MAX_BYTES);
    runCli(home, "rotation two");

    assert.equal(fs.existsSync(logPath(home) + ".2"), false, "no second generation may appear");
    assert.equal(fs.statSync(logPath(home) + ".1").size, RECALL_LOG_MAX_BYTES);
    assert.deepEqual(readLog(home).map((r) => r.query), ["rotation two"]);
  });
});

test("total on-disk size stays bounded by 2x the threshold", () => {
  withFakeHome((home) => {
    seedStore(home);
    seedLog(home, RECALL_LOG_MAX_BYTES);
    for (const q of ["a", "b", "c"]) runCli(home, q);

    const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const total = size(logPath(home)) + size(logPath(home) + ".1");
    assert.ok(total <= 2 * RECALL_LOG_MAX_BYTES, `bounded, got ${total}`);
  });
});

test("a rotation that cannot happen still lets the append happen", () => {
  withFakeHome((home) => {
    seedStore(home);
    seedLog(home, RECALL_LOG_MAX_BYTES);
    // A non-empty DIRECTORY at the rotation target: rename() raises. Rotation is
    // the housekeeping half of a log write and must not take the write with it.
    fs.mkdirSync(path.join(logPath(home) + ".1", "occupied"), { recursive: true });

    const out = runCli(home, "sqlite-vec embedding sync");
    assert.match(out, /<memory-context>/, "recall must still return its context");
    const rows = readLog(home);
    assert.equal(rows.length, 2, "filler + the new entry: the append still landed");
    assert.equal(rows[1].query, "sqlite-vec embedding sync");
  });
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
