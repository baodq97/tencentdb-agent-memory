"use strict";
// THE CONSOLIDATION CURSOR — software decides how far has been folded.
//
// The watermark used to be written by `tmem mark-done`, from inside the `claude -p`
// child, to MAX(updated_time) as of that moment — i.e. AFTER the child had read its
// atoms. Runs take a median 69.0s and up to 164.3s (the 17 runs carrying duration_ms
// in the production consolidation_runs.jsonl, 2026-09-04 -> 2026-09-07) and an
// active session keeps capturing the whole time, so every atom written between the
// child's `atoms --since-last` and its `mark-done` was marked consolidated without
// ever being read. Measured in that same window: 2 atoms, both in runs that exited
// 0. Silent, permanent, unlogged.
//
// The invariant these cases pin:
//   the runner cuts a cursor BEFORE the child exists;
//   the cursor is only as far as ONE run can actually read;
//   every read the child makes is bounded by it;
//   the watermark advances to exactly that cursor, and only on exit 0;
//   the lock opens when the runner's finally runs, never when the model says so.
//
// No test here starts a real `claude`: spawnSyncFn is injected everywhere, and the
// "child" is either a plain function or a real `node scripts/cli.js` call carrying
// the same env a real child would see. That env must carry MEMORY_TENCENTDB_HOME:
// a real `tmem` invoked from a stubbed spawn without it resolves to the DEVELOPER's
// live store — a test that writes to the machine it is measuring.

const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const runner = require("../scripts/consolidate_runner.js");
const pipeline = require("../scripts/memory_pipeline.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");
const { MemoryStore } = require("../scripts/memory_store.js");
const { envWithClaude } = require("./_fake_claude.js");

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";
const MID = "2026-03-15T00:00:00.000Z";   // written WHILE the run is in flight

/**
 * A throwaway store + project dir, with the env every actor in this file needs:
 * the runner reads the store root from process.env, and the CLI children get the
 * same root plus CLAUDE_PROJECT_DIR so they resolve the same project hash.
 */
function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cursor-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cursor-proj-"));
  const prev = {
    root: process.env.MEMORY_TENCENTDB_HOME,
    cap: process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY,
    auto: process.env.MEMORY_AUTO_CONSOLIDATE,
    dir: process.env.CLAUDE_PROJECT_DIR,
  };
  process.env.MEMORY_TENCENTDB_HOME = root;
  process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";  // never read the dev's config
  process.env.MEMORY_AUTO_CONSOLIDATE = "on";              // suite default is off; spawn is stubbed
  process.env.CLAUDE_PROJECT_DIR = proj;
  const hash = projectHashForCwd(proj);
  fs.mkdirSync(path.join(root, "projects", hash, "scene_blocks"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", hash, "changelog.jsonl"), "");
  try {
    return fn({ root, proj, hash });
  } finally {
    for (const [k, v] of [["MEMORY_TENCENTDB_HOME", prev.root],
                          ["MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY", prev.cap],
                          ["MEMORY_AUTO_CONSOLIDATE", prev.auto],
                          ["CLAUDE_PROJECT_DIR", prev.dir]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

/** Add atoms at controlled updated_time values to the project store. */
function seed(root, hash, atoms) {
  const store = new MemoryStore(path.join(root, "projects", hash, "index.db"));
  for (const a of atoms) {
    store.upsert({ id: a.id, content: a.content, type: a.type || "episodic",
      createdAt: a.ts, updatedAt: a.ts });
  }
  store.close();
}

const watermark = (root, hash) => {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf-8"));
    return (st.projects && st.projects[hash] && st.projects[hash].last_consolidated) || "";
  } catch { return ""; }
};

/**
 * Env for a `tmem` call made from INSIDE the run, exactly as the child sees it.
 * GUARD_ENV is unconditional in a real child (buildEnv sets it before anything
 * else) and the cursor is not — an empty store has no window to hand down — and
 * that asymmetry is load-bearing: GUARD_ENV, not the cursor, is what tells
 * mark-done a runner owns this run.
 */
const childEnv = (root, proj, cursor) => ({
  ...process.env, MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj,
  [runner.GUARD_ENV]: "1",
  ...(cursor ? { [runner.CURSOR_ENV]: cursor } : {}),
});

/** Env for a `tmem` call made by a HUMAN-driven consolidation: no runner at all. */
const manualEnv = (root, proj) => {
  const e = { ...process.env, MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj };
  delete e[runner.CURSOR_ENV];
  delete e[runner.GUARD_ENV];
  return e;
};

const tmem = (args, env) => execFileSync("node", [CLI, ...args], { encoding: "utf-8", env });

/* ── the cursor bounds the read ──────────────────────────────────────── */

test("the child is handed a cursor cut before it started, and its reads stop there", () => {
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T3 }]);
    let seenCursor = null, seenIds = null;
    runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: (_bin, _args, opts) => {
        seenCursor = opts.env[runner.CURSOR_ENV];
        // An atom lands mid-run, as one does while the session keeps talking.
        seed(root, hash, [{ id: "mid", content: "arrived during the run", ts: MID }]);
        const out = JSON.parse(tmem(["atoms", "project", "--since-last"], childEnv(root, proj, seenCursor)));
        seenIds = out.project.map((r) => r.record_id || r.id).sort();
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(seenCursor, T3, "the cursor is MAX(updated_time) as of before the spawn");
    assert.deepStrictEqual(seenIds, ["a", "b"], "the mid-run atom is outside the window the child was given");
  });
});

test("an atom written DURING a run is not swallowed — the next run still sees it", () => {
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T3 }]);
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => {
        seed(root, hash, [{ id: "mid", content: "arrived during the run", ts: MID }]);
        // A real child ends by marking done; under the old code THIS is the call
        // that took the watermark to MID and lost the atom.
        tmem(["mark-done"], childEnv(root, proj, T3));
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(rec.exit, 0);
    assert.strictEqual(watermark(root, hash), T3, "the watermark credits the window that was read, not 'now'");
    const next = JSON.parse(tmem(["atoms", "project", "--since-last"],
      { ...process.env, MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj }));
    assert.deepStrictEqual(next.project.map((r) => r.record_id || r.id), ["mid"],
      "the atom written mid-run is still pending for the next run");
  });
});

/* ── the window offered and the window credited are ONE window ───────── */

test("a backlog larger than one run's read limit is credited only as far as it is read", () => {
  // The cursor used to be MAX(updated_time) while the child's read was capped at
  // CONSOLIDATE_READ_LIMIT rows, so everything past the cap was credited unread —
  // permanently, since the watermark had moved past it. Reproduced end to end
  // before the fix with 600 atoms: the child read m_0000..m_0499, the watermark
  // jumped to m_0599, and the next run saw nothing. The live store holds a
  // project with 1,967 pending atoms and no watermark, where that first run would
  // have orphaned 1,467.
  const LIMIT = require("../scripts/constants.js").CONSOLIDATE_READ_LIMIT;
  const N = LIMIT + 20;
  withStore(({ root, proj, hash }) => {
    const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    seed(root, hash, Array.from({ length: N }, (_, i) => ({ id: `m_${i}`, content: `atom ${i}`, ts: at(i) })));

    let read = null, cursor = null;
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: (_b, _a, opts) => {
        cursor = opts.env[runner.CURSOR_ENV];
        read = JSON.parse(tmem(["atoms", "project", "--since-last"], childEnv(root, proj, cursor))).project;
        return { status: 0, stdout: "{}" };
      },
    });

    assert.strictEqual(read.length, LIMIT, "the child reads exactly one run's worth");
    assert.strictEqual(read[read.length - 1].updated_time, cursor,
      "and the cursor IS the last row it could read, not the newest row that exists");
    assert.strictEqual(rec.watermark_advanced, true);
    assert.strictEqual(watermark(root, hash), cursor);

    const next = JSON.parse(tmem(["atoms", "project", "--since-last"],
      { ...process.env, MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj })).project;
    assert.strictEqual(next.length, N - LIMIT, "the remainder is still pending, not silently folded");
    assert.strictEqual(next[0].record_id || next[0].id, `m_${LIMIT}`);
  });
});

test("an empty store at cut time does not fall back to advance-to-now", () => {
  // The "" cursor means two different things — "the store is empty" and
  // "projectCursor could not read it" — and neither may re-open the old defect.
  // It used to: absence of the cursor env var was read as "no runner", so the
  // child's own mark-done took the manual branch and advanced the watermark to a
  // live MAX(updated_time) computed AFTER the child had run. GUARD_ENV, which is
  // set on every child unconditionally, is what decides that now.
  withStore(({ root, proj, hash }) => {
    // Faithful child env: the store root must reach the child, or a `tmem` call
    // made from a stubbed spawn resolves to the developer's REAL memory store.
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter",
      env: envWithClaude({ MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj }),
      spawnSyncFn: (_b, _a, opts) => {
        assert.strictEqual(opts.env.MEMORY_TENCENTDB_HOME, root, "sandbox, not the real store");
        assert.ok(!(runner.CURSOR_ENV in opts.env), "no atoms ⇒ nothing to bound the child to");
        assert.strictEqual(opts.env[runner.GUARD_ENV], "1", "but the guard is always set");
        seed(root, hash, [{ id: "mid", content: "a live session captures mid-run", ts: MID }]);
        tmem(["mark-done"], opts.env);
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(rec.cursor, null);
    assert.strictEqual(rec.watermark_advanced, false);
    assert.strictEqual(watermark(root, hash), "", "nothing was read, so nothing is credited");
    const next = JSON.parse(tmem(["atoms", "project", "--since-last"],
      { ...process.env, MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj }));
    assert.deepStrictEqual(next.project.map((r) => r.record_id || r.id), ["mid"]);
  });
});

test("a runner's child never spends the MANUAL path's cut, cursor or no cursor", () => {
  // GUARD_ENV vs the cursor, isolated. An interactive consolidation that was
  // abandoned after its read leaves a cut parked in state.json; its lease later
  // expires and a background run fires on the same project. If mark-done decided
  // ownership by the CURSOR env var — absent here, because this store has nothing
  // to bound — the child would take the manual branch and credit a window that
  // this run never read. GUARD_ENV is set on every child, so it cannot.
  withStore(({ root, proj, hash }) => {
    const writer = require("../scripts/memory_writer.js");
    const prev = process.env.MEMORY_TENCENTDB_HOME;
    process.env.MEMORY_TENCENTDB_HOME = root;
    try { writer.setPendingReadCursor(hash, MID); } finally { process.env.MEMORY_TENCENTDB_HOME = prev; }

    runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter",
      env: envWithClaude({ MEMORY_TENCENTDB_HOME: root, CLAUDE_PROJECT_DIR: proj }),
      spawnSyncFn: (_b, _a, opts) => { tmem(["mark-done"], opts.env); return { status: 0, stdout: "{}" }; },
    });

    assert.strictEqual(watermark(root, hash), "", "the runner's child credits nothing it did not cut");
    const st = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf-8"));
    assert.strictEqual(st.projects[hash].pending_read_cursor, MID, "and leaves the manual cut where it was");
  });
});

/* ── the advance rule is derived, never judged ───────────────────────── */

test("a non-zero child exit does NOT advance the watermark, even if the child marked done", () => {
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T3 }]);
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => {
        tmem(["mark-done"], childEnv(root, proj, T3));   // the model says it is done
        return { status: 1, stdout: "{}" };              // the process says otherwise
      },
    });
    assert.strictEqual(rec.verdict, "failed");
    assert.strictEqual(rec.watermark_advanced, false);
    assert.strictEqual(watermark(root, hash), "", "a failed run re-offers the same window next time");
  });
});

test("a spawn error does NOT advance the watermark", () => {
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => { throw new Error("boom"); },
    });
    assert.strictEqual(watermark(root, hash), "");
  });
});

test("a no-op run (exit 0, nothing durable written) DOES advance the watermark", () => {
  // "I read them and none were durable" is a successful outcome. Not advancing
  // here would re-read a window that grows forever.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T3 }]);
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => ({ status: 0, stdout: "{}" }),
    });
    assert.strictEqual(rec.verdict, "no-op", "nothing was written, and that is recorded honestly");
    assert.strictEqual(rec.watermark_advanced, true);
    assert.strictEqual(watermark(root, hash), T3);
  });
});

test("an empty store yields no cursor and advances nothing", () => {
  withStore(({ root, proj, hash }) => {
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: (_b, _a, opts) => {
        assert.ok(!(runner.CURSOR_ENV in opts.env), "no atoms ⇒ nothing to bound the child to");
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(rec.cursor, null);
    assert.strictEqual(watermark(root, hash), "");
  });
});

/* ── lifecycle ownership ─────────────────────────────────────────────── */

test("a child calling `tmem mark-done` MID-RUN does not release the lock", () => {
  // The whole point: the mutex must not open on a model's judgement about which
  // step it is on. If it did, the store would be free for the rest of the run —
  // minutes — and a second trigger could start a concurrent consolidation on it.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    let lockedDuringRun = null;
    runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => {
        tmem(["mark-done"], childEnv(root, proj, T1));
        lockedDuringRun = pipeline.isLocked(hash);
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(lockedDuringRun, true, "the lock is still held after the child marked done");
    assert.strictEqual(pipeline.isLocked(hash), false, "and the runner's finally is what opens it");
  });
});

test("mark-done inside a run still resets the counter and the cascade marker", () => {
  // Those two records stay the child's job; only the watermark and the lock moved.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    const cs = path.join(root, "capture_state.json");
    fs.writeFileSync(cs, JSON.stringify({
      turn_count: 5,
      projects: { [hash]: { turn_count: 5, last_consolidation_turn: 0, consolidation_due: true } },
    }));
    tmem(["mark-done"], childEnv(root, proj, T1));
    const after = JSON.parse(fs.readFileSync(cs, "utf-8"));
    assert.strictEqual(after.projects[hash].consolidation_due, false, "counter reset");
    const cascade = JSON.parse(fs.readFileSync(path.join(root, "projects", hash, "cascade_state.json"), "utf-8"));
    assert.ok(cascade, "cascade marker written");
    assert.strictEqual(watermark(root, hash), "", "but the watermark is the runner's to write");
  });
});

/* ── the manual path (no runner anywhere) ────────────────────────────── */

test("the MANUAL path credits the window its READ cut, not the store as of mark-done", () => {
  // `/memory-seed` → the memory-consolidator agent → the consolidate skill. There
  // is no runner process here, so the cut is carried in state.json instead of an
  // env var: `tmem consolidate-context` cuts it, `tmem mark-done` spends it.
  //
  // What this pins is the same defect as the automatic path's, which survived
  // here after that one was fixed: mark-done used to recompute MAX(updated_time)
  // live, so an atom captured by another session WHILE the agent was folding —
  // read by nobody — was marked consolidated for ever.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T2 }]);
    const env = manualEnv(root, proj);

    const ctx = JSON.parse(tmem(["consolidate-context"], env));
    assert.deepStrictEqual(ctx.atoms.project.map((r) => r.record_id || r.id), ["a", "b"]);

    // A second session captures while the agent is folding.
    seed(root, hash, [{ id: "mid", content: "arrived during the fold", ts: T3 }]);

    tmem(["mark-done"], env);
    assert.strictEqual(watermark(root, hash), T2, "credited: exactly the window that was read");

    const next = JSON.parse(tmem(["atoms", "project", "--since-last"], env));
    assert.deepStrictEqual(next.project.map((r) => r.record_id || r.id), ["mid"],
      "the atom nobody read is still pending, not silently credited");
  });
});

test("a manual mark-done with no read window does not move the watermark at all", () => {
  // No `consolidate-context` ⇒ no cut ⇒ nothing was demonstrably read, so nothing
  // is credited. Re-reading atoms is free; crediting unread ones is not.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T2 }]);
    const env = manualEnv(root, proj);
    tmem(["mark-done"], env);
    assert.strictEqual(watermark(root, hash), "", "the watermark is never re-derived as 'now'");
    const next = JSON.parse(tmem(["atoms", "project", "--since-last"], env));
    assert.deepStrictEqual(next.project.map((r) => r.record_id || r.id).sort(), ["a", "b"]);
  });
});

test("the manual read is a real delta on the next round", () => {
  // The other half: a cut that IS spent must not leave the manual path re-reading
  // the same atoms for ever.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }, { id: "b", content: "two", ts: T2 }]);
    const env = manualEnv(root, proj);
    tmem(["consolidate-context"], env);
    tmem(["mark-done"], env);
    seed(root, hash, [{ id: "c", content: "three", ts: T3 }]);
    const ctx = JSON.parse(tmem(["consolidate-context"], env));
    assert.deepStrictEqual(ctx.atoms.project.map((r) => r.record_id || r.id), ["c"]);
  });
});

/* ── the manual path is no longer unguarded ──────────────────────────── */

test("a manual consolidation refuses to start on a store a runner is folding", () => {
  // Before the lease, /memory-seed during a background run read the store
  // unbounded and wrote scenes and persona over the same files the runner's child
  // was writing — two read-modify-write cycles, later writer wins, neither ever
  // observing the other.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    assert.strictEqual(pipeline.acquireLock(hash), true, "a background run is in flight");
    try {
      const out = JSON.parse(tmem(["consolidate-context"], manualEnv(root, proj)));
      assert.strictEqual(out.busy, true, "the manual read stands down instead of folding");
      assert.ok(!out.atoms, "and it hands the agent nothing to fold");
    } finally { pipeline.releaseLock(hash); }
  });
});

test("a runner refuses to start on a store a manual consolidation holds", () => {
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    tmem(["consolidate-context"], manualEnv(root, proj));   // takes the lease
    assert.strictEqual(pipeline.isLocked(hash), true, "the read left a lease behind");
    const rec = runner.runConsolidation({
      hash, projectDir: proj, trigger: "counter", env: envWithClaude(),
      spawnSyncFn: () => { throw new Error("a leased store must never reach spawn"); },
    });
    assert.strictEqual(rec.reason, "locked");
    tmem(["mark-done"], manualEnv(root, proj));
    assert.strictEqual(pipeline.isLocked(hash), false, "and mark-done ends the lease");
  });
});

test("a manual mark-done cannot open a background runner's lock", () => {
  // `releaseLock` is ownership-checked: the manual path may only end a MANUAL
  // lease. Unconditional unlink here is how a human running mark-done used to
  // free the store out from under a live run.
  withStore(({ root, proj, hash }) => {
    seed(root, hash, [{ id: "a", content: "one", ts: T1 }]);
    assert.strictEqual(pipeline.acquireLock(hash), true, "the runner's lock");
    try {
      tmem(["mark-done"], manualEnv(root, proj));
      assert.strictEqual(pipeline.isLocked(hash), true, "still held");
    } finally { pipeline.releaseLock(hash); }
  });
});
