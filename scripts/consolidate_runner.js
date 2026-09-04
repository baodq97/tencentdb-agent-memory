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
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { memoryBaseDir, projectDir } = require("./memory_writer.js");
const pipeline = require("./memory_pipeline.js");

const RUNS_LOG = () => path.join(memoryBaseDir(), "consolidation_runs.jsonl");

/** Guard env var. Set on the child; every tmem hook checks it and stands down. */
const GUARD_ENV = "TMEM_CONSOLIDATING";

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

/** Runs recorded in the last 24h, machine-wide. The cap and the audit trail read
 *  the same file so they cannot disagree about what happened. */
function runsInLastDay() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let n = 0;
    for (const line of fs.readFileSync(RUNS_LOG(), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // Only ATTEMPTS count against the cap. A run skipped because the cap was
        // already hit must not itself consume a slot, or one busy hour would
        // lock the machine out for the rest of the day.
        if (r.verdict !== "skipped" && Date.parse(r.at) >= cutoff) n++;
      } catch { /* skip malformed */ }
    }
    return n;
  } catch { return 0; }
}

function record(rec) {
  try {
    fs.mkdirSync(path.dirname(RUNS_LOG()), { recursive: true });
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
function buildEnv({ projectPath, baseEnv }) {
  const env = { ...(baseEnv || process.env) };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  env[GUARD_ENV] = "1";
  env.CLAUDE_PROJECT_DIR = projectPath;
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

  const skip = (reason) => {
    const rec = { project: hash, trigger, verdict: "skipped", reason };
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
  if (!pipeline.acquireLock(hash)) return skip("locked");

  const before = snapshot(hash);
  const started = Date.now();
  let out = null, exitCode = null, spawnError = null;

  try {
    const res = spawnSyncFn(claudeBin, buildArgs({
      model: cap.getConsolidateModel(),
      budgetUsd: cap.getConsolidateBudgetUsd(),
    }), {
      cwd: projectPath,                 // there is no --cwd for `claude -p`
      env: buildEnv({ projectPath, baseEnv }),
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    exitCode = res.status;
    if (res.error) spawnError = res.error.message;
    try { out = JSON.parse(String(res.stdout || "")); } catch { /* not fatal */ }
  } catch (e) {
    spawnError = e && e.message ? e.message : String(e);
  } finally {
    // Always. `tmem mark-done` releases the lock on the happy path, but a child
    // that crashed before reaching it must not wedge the project. releaseLock is
    // idempotent.
    try { pipeline.releaseLock(hash); } catch {}
  }

  const after = snapshot(hash);
  const changed = after.changelog > before.changelog || after.scenes !== before.scenes;

  // The classification the exit code cannot give. `no-op` is a real and expected
  // outcome — a delta with nothing durable in it — but it must be visible,
  // because a persistent run of no-ops is how a silently broken pipeline looks.
  const verdict = spawnError ? "failed" : (changed ? "changed" : (exitCode === 0 ? "no-op" : "failed"));

  const rec = {
    project: hash,
    trigger,
    model: cap.getConsolidateModel(),
    exit: exitCode,
    verdict,
    reason: spawnError || (out && out.subtype) || null,
    cost_usd: out && typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    turns: out && typeof out.num_turns === "number" ? out.num_turns : null,
    duration_ms: Date.now() - started,
    scenes_before: before.scenes,
    scenes_after: after.scenes,
    changelog_delta: after.changelog - before.changelog,
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
  spawnDetachedRunner,
  buildArgs,
  buildEnv,
  findClaude,
  snapshot,
  runsInLastDay,
  GUARD_ENV,
  RUNS_LOG,
};
