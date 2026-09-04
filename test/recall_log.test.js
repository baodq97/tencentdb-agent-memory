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
      ["at", "chars", "droppedIds", "injectedFactIds", "injectedIds", "query", "source"]);
    assert.ok(!Number.isNaN(Date.parse(row.at)));
    assert.ok(Array.isArray(row.injectedIds));
    assert.ok(Array.isArray(row.injectedFactIds));
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

// The log has to describe the block that was actually injected.
//
// It stopped doing that. `injectedIds` records ATOMS, and after the relevance
// floor and the project-scoped hook landed, atoms are no longer most of what a
// turn injects: 55 of the last 60 real logged recalls carried zero atom ids while
// each still injected around three scene facts. `tmem feedback` and doctor's
// hot/cold line read this file, so both were reporting near-silence about a
// surface that never stopped working. This pins the fix so the log cannot go
// blind again the next time the injected mix changes.
test("a turn that injects scene facts records them, not just atoms", () => {
  withFakeHome((home) => {
    seedStore(home);
    const gScenes = path.join(home, ".memory-tencentdb", "global", "scene_blocks");
    fs.mkdirSync(gScenes, { recursive: true });
    fs.writeFileSync(path.join(gScenes, "vector-index.md"), [
      "-----META-START-----",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "summary: vector index notes",
      "heat: 4",
      "-----META-END-----",
      "",
      "## Key Facts",
      "- sqlite-vec stores embeddings in an l1_vec virtual table keyed by record_id.",
    ].join("\n"));

    runCli(home, "where are embeddings stored");
    const [row] = readLog(home);
    assert.ok(row.injectedFactIds.length > 0,
      `a turn whose block carries scene facts must log them, got ${JSON.stringify(row)}`);
    for (const id of row.injectedFactIds) {
      // Scene-qualified and content-addressed: a positional id would be renamed by
      // every consolidation rewrite and make the log uncomparable across one.
      assert.match(id, /^fact:[^:]+:[0-9a-f]{12}$/, `unexpected fact id shape: ${id}`);
    }
  });
});

// The bug this pins shipped INSIDE the commit that added `injectedFactIds`:
// recallAsync computed factIds and then called finishRecall without them, so
// `finishRecall`'s `factIds = []` default logged an empty array on every
// hook-driven turn. Measured on the real store before the fix: 401 rows carried
// the field, 100% empty, while <recalled-facts> was delivering 4 facts a turn —
// and sync recall() logged 4 for the same query at the same moment.
//
// The existing coverage above could not catch it, and passed throughout. It drives
// the CLI in a fake HOME with no embed daemon, so recallAsync throws, cmdRecall
// falls back to sync recall(), and the assertion lands on the one path that was
// never broken. A test whose outcome is decided by whether a daemon happens to be
// reachable is not grading the code.
//
// So this drives recallAsync DIRECTLY with an injected embedder: the semantic path
// — the one hooks/scripts/on_user_prompt.js takes — with no daemon involved. Every
// text embeds to the same unit vector, so cosine is 1.0 and the floor is cleared
// deterministically rather than by timing.
test("recallAsync logs the facts it injected, not only its atoms", () => {
  withFakeHome((home) => {
    seedStore(home);
    const gScenes = path.join(home, ".memory-tencentdb", "global", "scene_blocks");
    fs.mkdirSync(gScenes, { recursive: true });
    fs.writeFileSync(path.join(gScenes, "vector-index.md"), [
      "-----META-START-----",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "summary: vector index notes",
      "heat: 4",
      "-----META-END-----",
      "",
      "## Key Facts",
      "- sqlite-vec stores embeddings in an l1_vec virtual table keyed by record_id.",
    ].join("\n"));

    const out = execFileSync("node", ["-e",
      `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL)});
       const unit = () => { const v = new Float32Array(8); v[0] = 1; return v; };
       const embedFn = async () => ({ vector: unit(), reason: "ok" });
       recallAsync("where are embeddings stored", "", 280, 5, RECALL_SOURCE.HOOK, { embedFn })
         .then((ctx) => { process.stdout.write(ctx || ""); process.exit(0); });`],
      { env: env(home), encoding: "utf-8" });

    assert.ok(out.includes("<recalled-facts>"),
      `precondition: the turn must inject facts, got:\n${out}`);
    const [row] = readLog(home);
    assert.ok(row.injectedFactIds.length > 0,
      `recallAsync must log the facts it injected, got ${JSON.stringify(row)}`);
    for (const id of row.injectedFactIds) {
      assert.match(id, /^fact:[^:]+:[0-9a-f]{12}$/, `unexpected fact id shape: ${id}`);
    }
  });
});

// A wall-clock bound on the whole recall, driven through the real entry point.
//
// The query embed budget went 500 -> 2500ms so a slow daemon stops silently
// costing the turn its semantic ranking. That is right for the query, but the
// fact stage runs FACT_EMBED_MAX_PER_TURN misses at FACT_EMBED_CONCURRENCY — four
// sequential waves — so at the same per-call budget a connected-but-stuck daemon
// (the `stuck` reason resolves only at the full timeout) would cost 4 x 2500ms
// there plus 2500ms for the query. hooks/hooks.json gives UserPromptSubmit 8s, and
// nothing carried an overall deadline, so the hook would be killed and the turn
// would get NO memory context — worse than the keyword fallback the raise removed.
//
// Facts get a tighter per-call budget and the stage a hard deadline, because the
// two are not the same question: the query embed is the critical path, a fact
// embed is a cache fill that converges over later turns.
test("a stuck embedder cannot blow the UserPromptSubmit budget", () => {
  withFakeHome((home) => {
    seedStore(home);
    const gScenes = path.join(home, ".memory-tencentdb", "global", "scene_blocks");
    fs.mkdirSync(gScenes, { recursive: true });
    // Enough distinct bullets to fill the per-turn miss batch several times over.
    fs.writeFileSync(path.join(gScenes, "many.md"), [
      "-----META-START-----", "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z", "summary: many facts", "heat: 4",
      "-----META-END-----", "", "## Key Facts",
      ...Array.from({ length: 20 }, (_, i) => `- distinct durable fact number ${i} about the store and its behaviour.`),
    ].join("\n"));

    const t0 = Date.now();
    execFileSync("node", ["-e",
      `const { recallAsync, RECALL_SOURCE } = require(${JSON.stringify(RECALL)});
       // Every call hangs to its own timeout, like a daemon that accepts the
       // connection and never answers.
       // The QUERY embed must SUCCEED — otherwise recallAsync fails closed and the
       // fact stage never runs, which is not the case under test. The worst case is
       // a daemon that answers the first call and then stops answering, so every
       // fact embed burns its full budget.
       let first = true;
       const unit = () => { const v = new Float32Array(8); v[0] = 1; return v; };
       const stuck = (text, opts) => {
         if (first) { first = false; return Promise.resolve({ vector: unit(), reason: "ok" }); }
         return new Promise((res) =>
           setTimeout(() => res({ vector: null, reason: "stuck" }), (opts && opts.timeoutMs) || 2500));
       };
       recallAsync("where are embeddings stored", "", 280, 5, RECALL_SOURCE.HOOK, { embedFn: stuck })
         .then(() => process.exit(0));`],
      { env: env(home), encoding: "utf-8" });
    const ms = Date.now() - t0;

    // 8000 is the hook timeout; assert with margin so this fails before production does.
    assert.ok(ms < 6000, `recall must stay inside the 8s hook budget, took ${ms}ms`);
  });
});
