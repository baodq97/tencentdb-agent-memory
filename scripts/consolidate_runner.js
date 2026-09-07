#!/usr/bin/env node
/**
 * Run consolidation as an unattended `claude -p` subprocess.
 *
 * WHY THIS EXISTS
 * ---------------
 * Consolidation used to run inside the user's own session: the Stop hook exited 2
 * with an `asyncRewake` message asking the main agent to dispatch the
 * memory-consolidator. That made the only step which turns raw L1 atoms into
 * readable L2 scene facts depend on the session complying, and spend the
 * session's own context to do it.
 *
 * Measured over 14 days of real traffic (838 injected turns, 17 projects): 74% of
 * sessions had ZERO scene write while they were still running, 19% of turns still
 * have no consolidation at all, and the median turn waited 4.15 h. Compliance was
 * not the problem — 24 of 26 woken sessions did dispatch — the wake almost never
 * fired. Meanwhile 40% of the turns memory could have served failed in INGEST
 * against 15% in recall, and six of eight ingest failures were content that WAS
 * captured but never distilled. This path is what distils it.
 *
 * TWO PROCESSES, ON PURPOSE
 * -------------------------
 * 1. A hook spawns this file detached and unref'd, so the hook returns in
 *    milliseconds and the work outlives the session. A plain async hook is not
 *    enough: Claude Code kills async hooks still running at `claude -p` teardown
 *    (docs: hooks, "Disable or remove hooks"), so a session that is itself
 *    headless would cancel its own consolidation.
 * 2. This file then runs `claude -p` SYNCHRONOUSLY, because the whole value of
 *    the second process is being alive afterwards to check what actually
 *    happened.
 *
 * NEVER TRUST THE EXIT CODE
 * -------------------------
 * The spike that validated this approach returned `is_error: false`, `num_turns:
 * 8`, and a confident "Memory pipeline complete... I folded it into the scene" —
 * while the store it was pointed at was byte-for-byte unchanged. Success is
 * therefore defined as a MEASURED delta in the store, and every run appends one
 * record to `consolidation_runs.jsonl` saying which it was.
 *
 * NOTHING HERE MAY DISTURB THE SESSION. Every failure path records a reason and
 * exits 0. No stderr, no exit 2, no wake-up. That property is the point of the
 * change and is asserted by test/consolidate_runner.test.js.
 *
 * A PATH SHIM CANNOT SANDBOX AN END-TO-END RUN. Read this before trying: two
 * separate attempts here wrote to the live store while believing they were
 * isolated.
 *
 * The child's `tmem` calls go through Claude Code's Bash tool, which starts a
 * LOGIN shell — the user's profile re-initialises PATH, so a shim placed at the
 * front of PATH is overridden and `tmem` resolves to the installed CLI. Verified:
 * `PATH=$SHIM:$PATH bash -lc 'command -v tmem'` returns ~/.local/bin/tmem while
 * `bash -c` returns the shim. The installed CLI is whatever version was released,
 * so it will not honour a MEMORY_TENCENTDB_HOME added in an unreleased tree, and
 * the run silently reads and writes the real store.
 *
 * What works instead is repointing the CLI the login shell already resolves:
 * `ln -sfn <repo>/scripts/tmem.js ~/.local/bin/tmem`. The launcher then finds its
 * sibling cli.js (resolution rule 2, the dev-repo case) rather than falling
 * through to the newest plugin-cache version, so the tree's
 * MEMORY_TENCENTDB_HOME is honoured. Verify through a LOGIN shell —
 * `bash -lc 'readlink -f $(command -v tmem)'` — not `bash -c`, which is the check
 * that passed while both earlier attempts were writing to the live store.
 *
 * MEASURED IN PRODUCTION, 2026-09-04. Six scopes, real backlogs (152/32/32/32/29/22
 * pending turns): 6/6 `verdict: changed`, 7-12 turns, 50-164 s, $0.41-1.11 each
 * ($4.07 total). One scope had a three-week-old stale lock (pid 680432); the
 * reclaim path took it and released cleanly.
 *
 * That run also validated what `snapshot()` measures. Consolidation's entire write
 * surface is L2/L3 — scene bodies, project doctrine, changelog. Across the six
 * scopes the recall-eligible L1 pool (type semantic/instruction) went 104 -> 103,
 * the -1 being a duplicate the child's own dedup removed, while scene-fact bullets
 * went 961 -> 1012 and scene files 98 -> 103. Counting eligible atoms would
 * therefore report every successful run as a no-op; scenes + changelog is the
 * correct success signal, and per skills/memory-consolidate/SKILL.md the scene-fact
 * bullet — not the L1 atom — is the per-turn recall surface by design.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { memoryBaseDir, projectDir, projectCursor, setConsolidatedWatermark } = require("./memory_writer.js");
const pipeline = require("./memory_pipeline.js");

/*
 * A LOCK-LOSING TRIGGER SURVIVES BY NOT BEING CONSUMED, NOT BY BEING QUEUED.
 * -------------------------------------------------------------------------
 * Two designs were on the table for "a trigger that loses the lock race must
 * not be discarded":
 *   (a) do not consume the trigger — leave the backlog counter alone so the
 *       next natural trigger retries.
 *   (b) a durable single-slot pending marker, drained by the lock holder on
 *       release.
 * (a) was chosen because it is already true at the state layer and needs no
 * new persistent state: capture_state.json's per-project counters
 * (slot.turn_count, slot.last_consolidation_turn) are reset ONLY by
 * markConsolidated() in memory_auto_capture.js, which fires ONLY from `tmem
 * mark-done` on a genuinely completed run. A lock miss here never calls it, so
 * the backlog that armed this trigger is still there for the next Stop or
 * counter tick to pick up. Verified against production log evidence: project
 * -home-bd-projects-nag-pilot-req-01 in consolidation_runs.jsonl shows four
 * session-end/locked skips (2026-09-05, 13:07-13:51) followed at 14:36 by a
 * counter-triggered run that landed `changed` — the backlog those four skips
 * represented, absorbed by the very next successful run, not lost.
 * (b) was rejected: it would duplicate bookkeeping the counter already does,
 * need its own drain-on-release step, and could itself go stale or wedge. The
 * actual gap this task closes is narrower than "the work is lost" — it is (1)
 * a lock-collision record that reads identically to a true loss in the runs
 * log, and (2) the session-end dispatcher spawning a doomed `claude` process on
 * every collision instead of checking cheaply first, the way the counter arm's
 * dispatcher already does. Both are fixed below without a new state file.
 */

const RUNS_LOG = () => path.join(memoryBaseDir(), "consolidation_runs.jsonl");

/** Guard env var. Set on the child; every tmem hook checks it and stands down. */
const GUARD_ENV = "TMEM_CONSOLIDATING";

/**
 * Cursor env var: the exact `updated_time` this run is allowed to fold up to,
 * cut by SOFTWARE before the child starts.
 *
 * Deliberately NOT folded into GUARD_ENV, which answers a different question
 * ("am I inside a run?", a re-entrancy guard read by every hook). This one
 * carries a value and only the consolidation child and the `tmem` calls it makes
 * ever read it. Its presence is also the signal to `tmem mark-done` that the
 * runner — not the model — owns the watermark and the lock for this run.
 */
const CURSOR_ENV = "TMEM_CONSOLIDATE_CURSOR";

/**
 * A CLOCK on the guarded work, derived from the lock's TTL.
 *
 * The lock now refuses to reclaim a provably-live holder — a TTL that can steal
 * the mutex from a running consolidation is a second concurrent run, which is
 * the failure this whole mechanism exists to prevent. That is only safe if a run
 * cannot outlive the TTL in the first place, and until now nothing bounded it:
 * `--max-turns` and `--max-budget-usd` are caps on work, not on time, and a child
 * stalled in a network call satisfies both forever.
 *
 * So spawnSync gets a timeout, and it is derived from LOCK_TTL_MS rather than
 * configured beside it — two independently-set numbers would eventually be set
 * in the wrong order, and "the run may outlive its lock" is exactly the state
 * that must be unreachable. A minute of headroom leaves the killed run time to
 * reach its finally and release the lock itself.
 */
function childTimeoutMs() {
  const ttl = pipeline.LOCK_TTL_MS;
  const want = parseInt(process.env.TMEM_CONSOLIDATE_TIMEOUT_MS || "", 10) || 20 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(want, ttl - 60 * 1000));
}
/**
 * Cap on the child's own turns. The consolidate skill's scope boundary keeps a
 * run to a handful of `tmem` calls; 40 is generous enough that a legitimate run
 * is never truncated mid-write, which would leave a half-written scene set.
 */
const MAX_TURNS = 40;

/* ------------------------------------------------------------------ *
 * preflight
 * ------------------------------------------------------------------ */

/**
 * Is the `claude` binary reachable?
 *
 * A PATH scan rather than `spawnSync("claude", ["--version"])`: this runs on a
 * path that must stay cheap, and starting the CLI just to learn it exists costs
 * more than reading a few directory entries. tmem is also distributed on npm
 * standalone, where there may be no Claude Code at all — those installs must
 * degrade to "skipped", never to an error.
 */
function findClaude(env) {
  const dirs = String((env || process.env).PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, "claude");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

/**
 * The tail of the runs log, parsed. ONE reader, used by the daily cap here and by
 * `tmem status` — a second copy would let the two disagree about malformed lines.
 *
 * TAIL, not the whole file. This log is append-only and never rotated: every run
 * AND every declined run writes a line, so on a busy multi-project machine it
 * grows without bound while every reader only ever wants the last day or week.
 * 256 KiB is ~1,300 records at the observed line size, far more than either
 * caller's window, and it makes the read cost constant instead of proportional
 * to the machine's entire history.
 */
function readRuns(bytes = 256 * 1024) {
  let text = "";
  try {
    const p = RUNS_LOG();
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf-8");
    } finally { fs.closeSync(fd); }
    // A non-zero offset almost certainly lands mid-record; drop the partial line
    // rather than letting it fail to parse and look like corruption.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch { return []; }

  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/** Runs recorded in the last 24h, machine-wide. */
function runsInLastDay() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // Only ATTEMPTS count against the cap. A run skipped because the cap was
  // already hit must not itself consume a slot, or one busy hour would lock the
  // machine out for the rest of the day.
  return readRuns().filter((r) => r.verdict !== "skipped" && Date.parse(r.at) >= cutoff).length;
}

function record(rec) {
  try {
    // Never CREATE the store root. This runs detached, after whatever spawned it
    // has moved on, so materialising a directory here would resurrect a store the
    // user (or a test) had just removed — and a run record inside a store that
    // does not exist is evidence of nothing. Declining to run must leave no trace.
    if (!fs.existsSync(memoryBaseDir())) return;
    fs.appendFileSync(RUNS_LOG(), JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
  } catch { /* the log is evidence, never a dependency */ }
}

/* ------------------------------------------------------------------ *
 * store snapshot — the only definition of success
 * ------------------------------------------------------------------ */

function snapshot(hash) {
  const dir = projectDir(hash);
  let scenes = 0, changelog = 0;
  try { scenes = fs.readdirSync(path.join(dir, "scene_blocks")).filter((f) => f.endsWith(".md")).length; } catch {}
  try { changelog = fs.readFileSync(path.join(dir, "changelog.jsonl"), "utf-8").split("\n").filter(Boolean).length; } catch {}
  // Scene COUNT alone would miss the commonest real outcome: an existing scene
  // updated in place with a new fact, which adds no file. The changelog length
  // catches that, and catches persona writes too.
  return { scenes, changelog };
}

/* ------------------------------------------------------------------ *
 * the child command
 * ------------------------------------------------------------------ */

/**
 * Argv for the headless child. Split out so a test can assert the flags without
 * running anything — these are the flags that keep an unattended run from
 * hanging on a permission prompt nobody can see, or from ingesting itself.
 */
function buildArgs({ model, budgetUsd }) {
  return [
    "-p", "/memory-consolidate",
    "--model", String(model),
    // Without this the child inherits the user's hooks, including tmem's own
    // capture hook, and ingests its own consolidation turns. Verified: with it,
    // the project's turn_count did not move across a full run.
    "--settings", JSON.stringify({ disableAllHooks: true }),
    // Unattended: deny anything that would need a human rather than blocking on
    // a prompt with no terminal attached.
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--allowedTools", "Bash,Read,Glob,Grep",
    "--max-turns", String(MAX_TURNS),
    "--max-budget-usd", String(budgetUsd),
    "--output-format", "json",
  ];
}

/**
 * Environment for the child.
 *
 * The messaging socket and token are inherited from the parent session and their
 * effect on a nested run is not verified, so they are removed rather than
 * trusted. MEMORY_TENCENTDB_HOME is passed through deliberately: it is what lets
 * an e2e test point a real run at a sandbox store instead of the user's memory.
 */
function buildEnv({ projectPath, baseEnv, cursor }) {
  const env = { ...(baseEnv || process.env) };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  env[GUARD_ENV] = "1";
  env.CLAUDE_PROJECT_DIR = projectPath;
  // The read window this run is bounded to. Absent when the store is empty (a
  // cold start has nothing to bound), and then the child reads the whole pool
  // exactly as before.
  if (cursor) env[CURSOR_ENV] = String(cursor);
  return env;
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

/**
 * Execute one consolidation for one project. Returns the record it wrote.
 *
 * `spawnSyncFn` is injectable for the same reason `embed_client` injects its
 * spawn: the interesting behaviour here is what happens AROUND the child, and a
 * test that has to start a real Claude session cannot cover the failure paths.
 */
function runConsolidation(opts) {
  const o = opts || {};
  const hash = o.hash || "";
  const projectPath = o.projectDir || process.cwd();
  const trigger = o.trigger || "unknown";
  const baseEnv = o.env || process.env;
  const spawnSyncFn = o.spawnSyncFn || spawnSync;
  const cap = require("./memory_auto_capture.js");
  // Resolved once. Each accessor re-reads config.json, and this function used to
  // call five of them — including getConsolidateModel() twice, once for the child
  // command and once for the record it writes afterwards.
  const model = cap.getConsolidateModel();

  const skip = (reason, extra) => {
    const rec = { project: hash, trigger, verdict: "skipped", reason, ...(extra || {}) };
    record(rec);
    return rec;
  };

  // Re-entrancy. `claude -p` inherits the parent environment and there is no
  // recursion guard in Claude Code itself, so this is ours.
  if (String(baseEnv[GUARD_ENV] || "")) return skip("reentrant");
  if (!cap.getAutoConsolidate()) return skip("disabled");

  const maxRuns = cap.getConsolidateMaxRunsPerDay();
  if (maxRuns <= 0) return skip("daily-cap-zero");
  if (runsInLastDay() >= maxRuns) return skip("daily-cap");

  const claudeBin = findClaude(baseEnv);
  if (!claudeBin) return skip("no-claude-binary");

  // Acquire LAST, and here rather than in the caller: acquisition is atomic
  // (O_EXCL), so two hooks racing to spawn resolve correctly, and a spawn that
  // never happens cannot leak a lock that would wedge the project for the full
  // 30-minute TTL.
  //
  // `retryable: true` and `turns_since_consolidation` distinguish this from a
  // real loss: the backlog counter this trigger read (slot.turn_count /
  // last_consolidation_turn in memory_auto_capture.js) is untouched by a lock
  // miss — only `markConsolidated()`, called from `tmem mark-done` on a genuinely
  // completed run, ever resets it — so the very next natural trigger (another
  // Stop, another counter tick) recomputes the same-or-larger delta and fires
  // again. Verified against production log evidence (project
  // -home-bd-projects-nag-pilot-req-01, 2026-09-05): four session-end/locked
  // skips between 13:07-13:51 were followed at 14:36 by a counter-triggered run
  // that landed `changed`, absorbing exactly the backlog those four skips
  // represented. Nothing was discarded at the state layer; the only real gap was
  // that this record looked identical to a true loss. getSlot(hash) is read-only
  // (readSlot never mutates state) so logging it here is side-effect-free.
  if (!pipeline.acquireLock(hash)) {
    const slot = cap.getSlot(hash);
    const turnsSinceConsolidation = (slot.turn_count || 0) - (slot.last_consolidation_turn || 0);
    return skip("locked", { retryable: true, turns_since_consolidation: turnsSinceConsolidation });
  }

  // THE CURSOR IS CUT HERE, BEFORE THE CHILD EXISTS.
  //
  // The watermark used to be set by `tmem mark-done` from inside the child, to
  // MAX(updated_time) as of THAT moment — i.e. after the child had already read
  // its atoms. A run takes a median 69.0s and up to 164.3s (the 17 runs carrying
  // duration_ms in consolidation_runs.jsonl, 2026-09-04 -> 2026-09-07), and an
  // active session keeps capturing atoms the whole time, so every atom written
  // between the child's `atoms --since-last` and its `mark-done` was marked
  // consolidated without ever being read. Measured in that same window: 2 atoms
  // across those 17 runs (both episodic, both on 2026-09-04, in runs that exited 0
  // with verdict "changed"). Small, but silent, permanent and unlogged.
  //
  // Cutting it here makes the advance DERIVED rather than judged: the child folds
  // a closed window and software credits exactly that window. Anything captured
  // during the run stays behind the watermark and is picked up by the next run.
  //
  // The cursor is also BOUNDED by how much one run can read: a run reads at most
  // constants.CONSOLIDATE_READ_LIMIT rows, and crediting MAX(updated_time) over a
  // larger backlog marked the remainder consolidated without anyone reading it.
  // Reproduced: 600 atoms, no watermark — the child read m_0000..m_0499 and the
  // watermark jumped to m_0599, permanently orphaning 100 atoms. Exactly one live
  // store is over the limit today (-home-bd-projects-aiquinta-platform: 1,967
  // records, no watermark), where the first run under the unbounded rule would
  // have credited 1,467 atoms nobody read. memory_writer.projectCursor
  // owns that computation; here it is simply the window this run may credit.
  const cursor = projectCursor(hash);

  const before = snapshot(hash);
  const started = Date.now();
  let out = null, exitCode = null, spawnError = null;

  try {
    const res = spawnSyncFn(claudeBin, buildArgs({
      model,
      budgetUsd: cap.getConsolidateBudgetUsd(),
    }), {
      cwd: projectPath,                 // there is no --cwd for `claude -p`
      env: buildEnv({ projectPath, baseEnv, cursor }),
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: childTimeoutMs(),
      killSignal: "SIGKILL",
    });
    exitCode = res.status;
    if (res.error) spawnError = res.error.message;
    try { out = JSON.parse(String(res.stdout || "")); } catch { /* not fatal */ }
  } catch (e) {
    spawnError = e && e.message ? e.message : String(e);
  } finally {
    // The ONLY release path for a run this process started. `tmem mark-done` used
    // to unlink the lock from inside the child, which meant a language model's
    // judgement about which step it was on decided when the mutex opened: call it
    // early and the lock is free for the rest of the run — minutes — long enough
    // for a second trigger to start a concurrent consolidation on the same store.
    // Here the lock is held for exactly as long as the guarded work runs, because
    // spawnSync is synchronous and this finally cannot run before the child exits.
    // Idempotent, and it also covers a child that crashed before doing anything.
    try { pipeline.releaseLock(hash); } catch {}
  }

  // Advance the watermark, in software, to the window that was actually offered
  // to the child — never to "now". A clean exit advances; a spawn error or a
  // non-zero exit does not, so the same window is re-offered next run. A `no-op`
  // verdict DOES advance: "I read them and none were durable" is a successful
  // outcome, and not advancing on it would re-read a forever-growing window.
  const advanced = !spawnError && exitCode === 0 && !!cursor;
  if (advanced) { try { setConsolidatedWatermark(hash, cursor); } catch {} }

  const after = snapshot(hash);
  const changed = after.changelog > before.changelog || after.scenes !== before.scenes;

  // The classification the exit code cannot give. `no-op` is a real and expected
  // outcome — a delta with nothing durable in it — but it must be visible,
  // because a persistent run of no-ops is how a silently broken pipeline looks.
  const verdict = spawnError ? "failed" : (changed ? "changed" : (exitCode === 0 ? "no-op" : "failed"));

  const rec = {
    project: hash,
    trigger,
    model,
    exit: exitCode,
    verdict,
    reason: spawnError || (out && out.subtype) || null,
    cost_usd: out && typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    turns: out && typeof out.num_turns === "number" ? out.num_turns : null,
    duration_ms: Date.now() - started,
    // The window this run was given and whether it was credited. Without these
    // two fields the runs log cannot answer "how far had we folded when this
    // ran", which is exactly the question the old silent advance made unanswerable.
    cursor: cursor || null,
    watermark_advanced: advanced,
    // A spawnSync timeout arrives as an ETIMEDOUT/SIGKILL error, which the
    // verdict already renders as "failed" — but "the run hit its ceiling" and
    // "the run crashed" want different responses, so the log distinguishes them.
    timed_out: !!(spawnError && /ETIMEDOUT|timed? ?out/i.test(spawnError)),
    scenes_before: before.scenes,
    scenes_after: after.scenes,
    changelog_delta: after.changelog - before.changelog,
    // The child's own last words, truncated. A `no-op` has two very different
    // causes — the delta genuinely held nothing durable, or the run silently
    // aborted (headless can report success with a bare result when an injected
    // command is refused) — and without this the runs log cannot tell them
    // apart. Capped because this file is appended to on every run forever.
    result_head: out && typeof out.result === "string" ? out.result.slice(0, 400) : null,
  };
  record(rec);
  return rec;
}

/**
 * Fire-and-forget entry used by the hooks: spawn THIS file detached so the hook
 * returns immediately. Same shape as the digest spawn in hooks/scripts/on_stop.js
 * and the daemon spawn in scripts/embed_client.js.
 */
function spawnDetachedRunner(opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || spawn;
  const baseEnv = o.env || process.env;
  if (String(baseEnv[GUARD_ENV] || "")) return false;   // never recurse
  // Check the switch HERE too, not only in the child. Spawning a node process on
  // every Stop just so it can read a config file and exit is the kind of cost
  // that is invisible until it is measured.
  try { if (!require("./memory_auto_capture.js").getAutoConsolidate()) return false; } catch {}

  // Cheap pre-check, mirroring the pre-filter memory_pipeline.js's selectTargets
  // already applies to the counter arm (see that file, ~line 262) before it ever
  // calls this function. hooks/scripts/on_session_end.js has no such filter of
  // its own — it calls spawnDetachedRunner unconditionally on every session end —
  // so this is the one choke point both dispatchers share where a doomed spawn
  // can be avoided. Measured: all 9 `reason:"locked"` records in
  // consolidation_runs.jsonl over 24 runs (2026-09-04 -> 2026-09-07) have
  // trigger:"session-end" and zero have trigger:"counter", which is exactly what
  // a missing pre-check on only one of the two dispatchers would produce. This
  // is a non-atomic read, same as memory_pipeline.js's own pre-filter — a race
  // between this check and the real acquire in runConsolidation is expected and
  // harmless (an occasional process still gets spawned and finds the lock a few
  // ms later, exactly like before this change); do not try to make it atomic, or
  // it becomes a second lock implementation.
  const hash = String(o.hash || "");
  try {
    if (pipeline.isLocked(hash)) {
      const cap = require("./memory_auto_capture.js");
      const slot = cap.getSlot(hash);
      const turnsSinceConsolidation = (slot.turn_count || 0) - (slot.last_consolidation_turn || 0);
      record({
        project: hash,
        trigger: o.trigger || "unknown",
        verdict: "skipped",
        reason: "locked",
        retryable: true,
        turns_since_consolidation: turnsSinceConsolidation,
      });
      return false;
    }
  } catch { /* fall through to spawn — the real acquire is the source of truth */ }

  try {
    const child = spawnFn(process.execPath, [
      __filename,
      "--hash", String(o.hash || ""),
      "--project-dir", String(o.projectDir || process.cwd()),
      "--trigger", String(o.trigger || "unknown"),
    ], {
      cwd: o.projectDir || process.cwd(),
      env: { ...baseEnv },
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch {
    // A hook must never fail because consolidation could not start.
    return false;
  }
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = String(argv[i] || "").replace(/^--/, "");
    if (k) out[k] = argv[i + 1];
  }
  return out;
}

if (require.main === module) {
  const a = parseArgv(process.argv.slice(2));
  try {
    runConsolidation({ hash: a.hash || "", projectDir: a["project-dir"], trigger: a.trigger });
  } catch (e) {
    record({ project: a.hash || "", trigger: a.trigger || "unknown", verdict: "failed", reason: e && e.message });
  }
  process.exit(0);   // never signal anything to anyone
}

module.exports = {
  runConsolidation,
  readRuns,
  spawnDetachedRunner,
  buildArgs,
  buildEnv,
  findClaude,
  snapshot,
  runsInLastDay,
  GUARD_ENV,
  CURSOR_ENV,
  RUNS_LOG,
};
