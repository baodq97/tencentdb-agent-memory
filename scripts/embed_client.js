#!/usr/bin/env node
/**
 * Thin client for the resident embedding daemon (embed_daemon.js).
 *
 * embedViaDaemon(text) returns a 768-d Float32Array from the daemon, or null on
 * ANY failure (no daemon, warming, timeout, bad reply). null is the signal to the
 * caller to fall back to FTS-only — the daemon is never a correctness dependency.
 *
 * ensureDaemon() spawns the daemon detached so it survives this short-lived process;
 * it is best-effort and never blocks.
 */
"use strict";

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { addrForDir } = require("./embed_daemon.js");

const DAEMON_PATH = path.join(__dirname, "embed_daemon.js");
// Warm round-trip (connect + embed + JSON both ways) measured at ~70ms median,
// with idle-wake first calls spiking to ~280ms. 500ms gives headroom for jitter
// while a down daemon still fails fast via ENOENT (no added latency when absent).
const DEFAULT_TIMEOUT_MS = 500;

function daemonAddr() {
  return addrForDir(__dirname);
}

/** Spawn the daemon detached (best-effort, non-blocking). */
function ensureDaemon() {
  try {
    const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}

/**
 * Ask the daemon to embed `text`. Resolves to Float32Array(768) or null.
 * A single hard deadline covers connect + request + response.
 */
function embedViaDaemon(text, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const addr = daemonAddr();
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    const sock = net.connect(addr);
    sock.setEncoding("utf-8");

    sock.on("connect", () => {
      sock.write(JSON.stringify({ op: "embed", text }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let resp;
      try { resp = JSON.parse(buf.slice(0, nl)); } catch { return finish(null); }
      if (resp && Array.isArray(resp.vector)) return finish(Float32Array.from(resp.vector));
      finish(null); // {error:...} or anything unexpected
    });
    sock.on("error", (err) => {
      // no daemon listening — kick off a spawn for next turn, fall back now
      if (err && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) ensureDaemon();
      finish(null);
    });
  });
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

module.exports = { embedViaDaemon, ensureDaemon, daemonAddr, pingDaemon };
