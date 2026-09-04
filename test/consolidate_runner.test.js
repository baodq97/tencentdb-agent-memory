"use strict";
// The unattended consolidation runner.
//
// Everything here is about what happens AROUND the model call, because that is
// where this can go wrong in ways nobody would notice:
//
//  - it must never disturb the session (no stderr, no non-zero exit, no wake);
//  - it must never ingest itself (the child inherits the user's hooks unless
//    told otherwise, and tmem's own capture hook is one of them);
//  - it must never call success what the store did not record — the spike that
//    validated this design returned is_error:false and "I folded it into the
//    scene" while its target store was byte-for-byte unchanged;
//  - it must never leave a lock behind, or the project is wedged for the full
//    30-minute TTL;
//  - and on a machine with no Claude Code at all (tmem also ships standalone on
//    npm) it must degrade to a recorded skip.
//
// No test in this file may start a real `claude` process: every case either
// stops in preflight or injects spawnSyncFn.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("../scripts/consolidate_runner.js");
const lock = require("../scripts/memory_pipeline.js");

const HASH = "-test-consolidate-runner";

/** A throwaway store root, via the override that exists for exactly this. */
function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-runner-"));
  const prev = process.env.MEMORY_TENCENTDB_HOME;
  const prevCap = process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY;
  const prevAuto = process.env.MEMORY_AUTO_CONSOLIDATE;
  process.env.MEMORY_TENCENTDB_HOME = root;
  process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "12";   // pin: never read the dev's config
  // The suite runs with MEMORY_AUTO_CONSOLIDATE=off so that no test anywhere can
  // reach a real `claude -p` and bill the user. These cases are ABOUT the runner,
  // so they opt back in explicitly — and every one of them injects spawnSyncFn,
  // so nothing is ever started.
  process.env.MEMORY_AUTO_CONSOLIDATE = "on";
  fs.mkdirSync(path.join(root, "projects", HASH, "scene_blocks"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", HASH, "changelog.jsonl"), "");
  try { return fn(root); } finally {
    if (prev === undefined) delete process.env.MEMORY_TENCENTDB_HOME; else process.env.MEMORY_TENCENTDB_HOME = prev;
    if (prevCap === undefined) delete process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY; else process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = prevCap;
    if (prevAuto === undefined) delete process.env.MEMORY_AUTO_CONSOLIDATE; else process.env.MEMORY_AUTO_CONSOLIDATE = prevAuto;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const runsIn = (root) => fs.readFileSync(path.join(root, "consolidation_runs.jsonl"), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

/* ── the child command ───────────────────────────────────────────────── */

test("the child is told to disable hooks, or it ingests its own output", () => {
  // Without --settings disableAllHooks the subprocess loads the user's hooks,
  // including tmem's UserPromptSubmit and Stop hooks, and captures its own
  // consolidation turns as new atoms — a self-feeding loop.
  const a = runner.buildArgs({ model: "sonnet", budgetUsd: 1.5 });
  const i = a.indexOf("--settings");
  assert.ok(i > -1, "--settings must be passed");
  assert.deepStrictEqual(JSON.parse(a[i + 1]), { disableAllHooks: true });
});

test("the child cannot block on a permission prompt nobody can see", () => {
  const a = runner.buildArgs({ model: "sonnet", budgetUsd: 1.5 });
  assert.strictEqual(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assert.strictEqual(a[a.indexOf("--permission-prompts") + 1], "none");
  assert.ok(a.includes("--max-turns"), "an unattended run must be bounded");
});

test("the model and the spend ceiling are both passed through", () => {
  const a = runner.buildArgs({ model: "haiku", budgetUsd: 0.25 });
  assert.strictEqual(a[a.indexOf("--model") + 1], "haiku");
  assert.strictEqual(a[a.indexOf("--max-budget-usd") + 1], "0.25");
});

test("the child env sets the guard and drops the inherited messaging channel", () => {
  const env = runner.buildEnv({
    projectPath: "/tmp/p",
    baseEnv: { PATH: "/usr/bin", CLAUDE_CODE_MESSAGING_SOCKET: "s", CLAUDE_CODE_MESSAGING_TOKEN: "t" },
  });
  assert.strictEqual(env[runner.GUARD_ENV], "1");
  assert.strictEqual(env.CLAUDE_PROJECT_DIR, "/tmp/p");
  // Inherited from the parent session; their effect on a nested run is not
  // verified, so they are removed rather than trusted.
  assert.ok(!("CLAUDE_CODE_MESSAGING_SOCKET" in env));
  assert.ok(!("CLAUDE_CODE_MESSAGING_TOKEN" in env));
});

/* ── preflight ───────────────────────────────────────────────────────── */

test("a run inside a run refuses — there is no recursion guard in Claude Code", () => {
  withRoot((root) => {
    const rec = runner.runConsolidation({
      hash: HASH, env: { [runner.GUARD_ENV]: "1" },
      spawnSyncFn: () => { throw new Error("must not spawn"); },
    });
    assert.strictEqual(rec.verdict, "skipped");
    assert.strictEqual(rec.reason, "reentrant");
    assert.strictEqual(runsIn(root).length, 1, "and the refusal is still recorded");
  });
});

test("no claude binary degrades to a recorded skip, never an error", () => {
  // tmem ships standalone on npm. An install with no Claude Code must lose the
  // feature quietly, not break the Stop hook.
  withRoot(() => {
    const rec = runner.runConsolidation({
      hash: HASH, env: { PATH: "/nonexistent-dir-for-this-test" },
      spawnSyncFn: () => { throw new Error("must not spawn"); },
    });
    assert.strictEqual(rec.verdict, "skipped");
    assert.strictEqual(rec.reason, "no-claude-binary");
  });
});

test("the daily cap counts attempts only, so a capped day cannot lock itself out", () => {
  withRoot((root) => {
    const log = path.join(root, "consolidation_runs.jsonl");
    const now = new Date().toISOString();
    // 2 real attempts + 5 skips. With the cap at 3, skips must not have consumed
    // the remaining slot: a busy hour of refusals would otherwise disable the
    // machine for the rest of the day.
    const lines = [
      ...Array.from({ length: 2 }, () => ({ at: now, verdict: "changed" })),
      ...Array.from({ length: 5 }, () => ({ at: now, verdict: "skipped" })),
    ];
    fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.strictEqual(runner.runsInLastDay(), 2);

    process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "3";
    let spawned = false;
    runner.runConsolidation({ hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => { spawned = true; return { status: 0, stdout: "{}" }; } });
    assert.strictEqual(spawned, true, "the third attempt is still allowed");

    process.env.MEMORY_CONSOLIDATE_MAX_RUNS_PER_DAY = "2";
    const rec = runner.runConsolidation({ hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => { throw new Error("must not spawn past the cap"); } });
    assert.strictEqual(rec.reason, "daily-cap");
  });
});

test("runs older than 24h do not count against the cap", () => {
  withRoot((root) => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(root, "consolidation_runs.jsonl"),
      Array.from({ length: 50 }, () => JSON.stringify({ at: old, verdict: "changed" })).join("\n") + "\n");
    assert.strictEqual(runner.runsInLastDay(), 0);
  });
});

/* ── the verdict ─────────────────────────────────────────────────────── */

test("exit 0 with an unchanged store is a NO-OP, not a success", () => {
  // The failure this whole classification exists for. Measured: a real headless
  // run returned is_error:false, num_turns:8, and prose claiming it had folded a
  // fact into a scene, while the store it was pointed at did not change at all.
  withRoot((root) => {
    const rec = runner.runConsolidation({
      hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify({ is_error: false, num_turns: 8, total_cost_usd: 0.45 }) }),
    });
    assert.strictEqual(rec.verdict, "no-op");
    assert.strictEqual(rec.changelog_delta, 0);
    assert.strictEqual(rec.cost_usd, 0.45, "cost is recorded even for a no-op — it was still spent");
    assert.strictEqual(runsIn(root).length, 1);
  });
});

test("a store that actually moved is CHANGED", () => {
  withRoot((root) => {
    const cl = path.join(root, "projects", HASH, "changelog.jsonl");
    const rec = runner.runConsolidation({
      hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => {
        fs.appendFileSync(cl, JSON.stringify({ action: "updated", type: "scene" }) + "\n");
        return { status: 0, stdout: JSON.stringify({ total_cost_usd: 0.4 }) };
      },
    });
    assert.strictEqual(rec.verdict, "changed");
    assert.strictEqual(rec.changelog_delta, 1);
  });
});

test("an updated-in-place scene counts, even though no file is added", () => {
  // Scene COUNT alone would miss the commonest real outcome: a new fact folded
  // into a scene that already exists.
  withRoot((root) => {
    const dir = path.join(root, "projects", HASH, "scene_blocks");
    fs.writeFileSync(path.join(dir, "existing.md"), "before");
    const cl = path.join(root, "projects", HASH, "changelog.jsonl");
    const rec = runner.runConsolidation({
      hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => {
        fs.writeFileSync(path.join(dir, "existing.md"), "after");
        fs.appendFileSync(cl, JSON.stringify({ action: "updated", type: "scene" }) + "\n");
        return { status: 0, stdout: "{}" };
      },
    });
    assert.strictEqual(rec.scenes_before, rec.scenes_after, "no new file, on purpose");
    assert.strictEqual(rec.verdict, "changed");
  });
});

test("a spawn that throws is FAILED and still releases the lock", () => {
  withRoot(() => {
    const rec = runner.runConsolidation({
      hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => { throw new Error("boom"); },
    });
    assert.strictEqual(rec.verdict, "failed");
    assert.match(String(rec.reason), /boom/);
    // A crashed run must not wedge the project until the 30-minute TTL expires.
    assert.strictEqual(lock.isLocked(HASH), false, "the lock is released in a finally");
  });
});

test("the lock is released on the happy path too", () => {
  withRoot(() => {
    runner.runConsolidation({
      hash: HASH, env: { PATH: process.env.PATH },
      spawnSyncFn: () => ({ status: 0, stdout: "{}" }),
    });
    assert.strictEqual(lock.isLocked(HASH), false);
  });
});

/* ── the detached spawn ──────────────────────────────────────────────── */

test("the switch is checked before spawning, not only inside the child", () => {
  // Otherwise every Stop starts a node process whose only job is to read a
  // config file and exit. The suite runs with MEMORY_AUTO_CONSOLIDATE=off, so
  // this is the ambient state.
  const ok = runner.spawnDetachedRunner({
    hash: HASH, projectDir: "/tmp/p", trigger: "counter",
    env: { PATH: "/usr/bin" },
    spawnFn: () => { throw new Error("must not spawn when auto-consolidation is off"); },
  });
  assert.strictEqual(ok, false);
});

test("the hook-side spawn is detached and unref'd, so a hook returns at once", () => {
  const prev = process.env.MEMORY_AUTO_CONSOLIDATE;
  process.env.MEMORY_AUTO_CONSOLIDATE = "on";
  let opts = null, unrefd = false;
  let ok;
  try {
    ok = runner.spawnDetachedRunner({
      hash: HASH, projectDir: "/tmp/p", trigger: "session-end",
      env: { PATH: "/usr/bin" },
      spawnFn: (_bin, _args, o) => { opts = o; return { unref: () => { unrefd = true; } }; },
    });
  } finally {
    if (prev === undefined) delete process.env.MEMORY_AUTO_CONSOLIDATE; else process.env.MEMORY_AUTO_CONSOLIDATE = prev;
  }
  assert.strictEqual(ok, true);
  assert.strictEqual(opts.detached, true);
  assert.strictEqual(opts.stdio, "ignore", "a hook must not hold the child's pipes open");
  assert.strictEqual(unrefd, true);
});

test("the detached spawn refuses to recurse", () => {
  const ok = runner.spawnDetachedRunner({
    hash: HASH, env: { [runner.GUARD_ENV]: "1" },
    spawnFn: () => { throw new Error("must not spawn"); },
  });
  assert.strictEqual(ok, false);
});

test("a spawn failure is swallowed — a hook must never fail because of memory", () => {
  const ok = runner.spawnDetachedRunner({
    hash: HASH, env: { PATH: "/usr/bin" },
    spawnFn: () => { throw new Error("EAGAIN"); },
  });
  assert.strictEqual(ok, false, "reported, not thrown");
});
