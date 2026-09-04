#!/usr/bin/env node
/**
 * Thin client for the resident embedding daemon (embed_daemon.js).
 *
 * embedViaDaemonStatus(text) returns { vector, reason } — the reason is what lets
 * a caller REPORT the FTS-only fallback instead of silently treating a null vector
 * as a healthy keyword-only result. embedViaDaemon(text) is the thin backwards-
 * compatible wrapper that returns just the vector (Float32Array(768) or null).
 * The daemon is never a correctness dependency: any failure falls open to FTS.
 *
 * ensureDaemon() REVIVES a dead daemon. It reads the pidfile and only spawns when
 * nothing live owns the address (stale/missing pid), so a crashed daemon self-heals
 * across turns while a live one is never duplicated. Best-effort, never throws.
 */
"use strict";

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { addrForDir, readPidFile, pidAlive } = require("./embed_daemon.js");

const SCRIPTS_DIR = __dirname;
const DAEMON_PATH = path.join(__dirname, "embed_daemon.js");
// A TIMEOUT IS A CEILING, NOT A WAIT. The call returns the moment the daemon
// replies, so a higher bound costs nothing on the common path — it only decides
// when we give up and answer with something worse.
//
// 500ms was set from "~70ms median, idle-wake first calls spiking to ~280ms".
// Re-measured 2026-09-04 on this machine, both numbers are wrong:
//   idle       n=20  p50 120ms  p90 1345ms  p99 2037ms   5/20 over 500ms
//   under load n=30  p50 131ms  p90  431ms  p99  985ms   3/30 over 500ms
// The budget sat between p50 and p90, so it fired on roughly one call in ten.
// Note idle is WORSE at the tail than loaded: after a gap the model is
// descheduled and the first call pays to bring it back. That is the same
// "idle-wake spike" the old comment named, about 5x larger than it assumed.
//
// WHAT THE OLD BUDGET COST. This is the only embed on the recall hot path, and
// recallAsync treats a null vector as "no query vector", which silently drops the
// turn to keyword ranking — measured at 48% of facts surfaced versus 91% for the
// semantic path. So the timeout was not degrading latency, it was degrading
// ANSWERS, on ~10% of turns, with no signal to anyone.
//
// 2500ms clears the measured p99 with margin. A daemon that is actually absent
// still fails fast via ENOENT rather than waiting this out, so the new ceiling is
// only ever paid when the daemon is connected and mid-inference — exactly the
// case where waiting beats answering from keywords. It stays well inside the 8s
// hook budget.
const DEFAULT_TIMEOUT_MS = 2500;

// Don't spawn a daemon storm when many embeds fail back-to-back within one process
// (e.g. a recall loop while the daemon is still warming). One revive attempt per
// window is plenty — the daemon binds its address as a mutex, so a redundant spawn
// would just exit, but skipping it avoids needless process churn.
const SPAWN_THROTTLE_MS = parseInt(process.env.TMEM_DAEMON_SPAWN_THROTTLE_MS || "", 10) || 3000;
let _lastSpawnAt = 0;

function daemonAddr() {
  return addrForDir(SCRIPTS_DIR);
}

/**
 * Revive the daemon if it is not running. Idempotent: when the pidfile names a
 * live process we assume that process owns the address (the daemon binds addr as
 * a mutex) and do NOT spawn a duplicate — only a stale/missing pidfile triggers a
 * spawn. Best-effort and non-blocking; never throws.
 *
 * opts.dir     — which store's pidfile to inspect (default: this scripts dir).
 * opts.force   — bypass the per-process spawn throttle.
 * opts.spawnFn — injectable spawn (tests); defaults to child_process.spawn.
 * Returns { spawned, reason } for observability/tests.
 */
function ensureDaemon(opts = {}) {
  const dir = opts.dir || SCRIPTS_DIR;
  const spawnFn = opts.spawnFn || spawn;
  try {
    const pid = readPidFile(dir);
    if (pid && pidAlive(pid)) return { spawned: false, reason: "already-running" };

    const now = Date.now();
    if (!opts.force && now - _lastSpawnAt < SPAWN_THROTTLE_MS) {
      return { spawned: false, reason: "throttled" };
    }
    _lastSpawnAt = now;

    // A crashed daemon leaves a stale socket; the daemon itself unlinks it on
    // EADDRINUSE (see embed_daemon.js), so we don't touch it here — unlinking a
    // socket still owned by a live-but-pidfile-less daemon would break it.
    const child = spawnFn(process.execPath, [DAEMON_PATH], { detached: true, stdio: "ignore" });
    if (child && typeof child.unref === "function") child.unref();
    return { spawned: true, reason: pid ? "stale-pid" : "no-pid" };
  } catch {
    return { spawned: false, reason: "spawn-error" };
  }
}

/**
 * Ask the daemon to embed `text`. Resolves { vector, reason } where reason is one of:
 *   ready    — got a vector (vector is a Float32Array)
 *   down     — nothing listening (ENOENT/ECONNREFUSED)
 *   warming  — alive but model still loading
 *   failed   — alive but model load failed
 *   stuck    — connected but no reply within the deadline (hung daemon)
 *   badreply — replied with a shape we don't understand
 *   error    — some other socket error
 * On any non-ready reason the vector is null (fall open to FTS). When the daemon is
 * unavailable (not merely warming/failed) a revive is kicked off for the next turn.
 * A single hard deadline covers connect + request + response.
 */
function embedViaDaemonStatus(text, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const addr = opts.addr || daemonAddr();
  const autoRevive = opts.autoRevive !== false;
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    let connected = false;
    const finish = (vector, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      // Self-heal for the next turn when the daemon is genuinely unavailable.
      // warming/failed mean a live daemon already owns the address, so a spawn
      // would be a pointless no-op — skip it.
      if (!vector && autoRevive && reason !== "warming" && reason !== "failed") {
        ensureDaemon(opts.reviveOpts);
      }
      resolve({ vector, reason });
    };

    const timer = setTimeout(() => finish(null, connected ? "stuck" : "down"), timeoutMs);
    timer.unref();

    const sock = net.connect(addr);
    sock.setEncoding("utf-8");

    sock.on("connect", () => {
      connected = true;
      sock.write(JSON.stringify({ op: "embed", text }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let resp;
      try { resp = JSON.parse(buf.slice(0, nl)); } catch { return finish(null, "badreply"); }
      if (resp && Array.isArray(resp.vector)) return finish(Float32Array.from(resp.vector), "ready");
      if (resp && resp.error === "warming") return finish(null, "warming");
      if (resp && resp.error === "failed") return finish(null, "failed");
      finish(null, "badreply");
    });
    sock.on("error", (err) => {
      const reason = err && (err.code === "ENOENT" || err.code === "ECONNREFUSED") ? "down" : "error";
      finish(null, reason);
    });
  });
}

/**
 * Backwards-compatible wrapper: resolves the Float32Array(768) or null. Callers that
 * need to REPORT why recall fell back to FTS should use embedViaDaemonStatus instead.
 */
function embedViaDaemon(text, opts = {}) {
  return embedViaDaemonStatus(text, opts).then((r) => r.vector);
}

/**
 * Health-check the daemon WITHOUT spawning one (unlike embedViaDaemon, which
 * auto-spawns on a connect error). Resolves a discriminated state:
 *   ready   — replied with a vector (also returns vlen)
 *   warming — alive but model still loading
 *   failed  — alive but model load failed
 *   stuck   — connected but no reply within the deadline (hung daemon)
 *   down    — nothing listening (ENOENT/ECONNREFUSED)
 *   badreply— connected and replied, but not a shape we understand
 * Used by `tmem daemon status|start`; never falls back, never spawns.
 */
function pingDaemon(opts = {}) {
  const timeoutMs = opts.timeoutMs || 1500;
  const addr = daemonAddr();
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    let connected = false;
    const finish = (state, extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(Object.assign({ state }, extra));
    };
    const timer = setTimeout(() => finish(connected ? "stuck" : "down"), timeoutMs);
    timer.unref();

    const sock = net.connect(addr);
    sock.setEncoding("utf-8");
    sock.on("connect", () => {
      connected = true;
      sock.write(JSON.stringify({ op: "embed", text: "ping" }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let resp;
      try { resp = JSON.parse(buf.slice(0, nl)); } catch { return finish("badreply"); }
      if (resp && Array.isArray(resp.vector)) return finish("ready", { vlen: resp.vector.length });
      if (resp && resp.error === "warming") return finish("warming");
      if (resp && resp.error === "failed") return finish("failed");
      finish("badreply", { reply: resp });
    });
    sock.on("error", () => finish("down"));
  });
}

module.exports = { embedViaDaemon, embedViaDaemonStatus, ensureDaemon, daemonAddr, pingDaemon };
