#!/usr/bin/env node
/**
 * Resident embedding daemon.
 *
 * One long-lived process holds EmbeddingGemma in RAM and serves text -> 768-d
 * vector over a local IPC channel (named pipe on Windows, unix socket on POSIX).
 * The per-turn hook is a thin client (see embed_client.js); the daemon is a pure,
 * stateless embed function. NO DB access, NO recall/RRF logic.
 *
 * Lifecycle:
 *   - bind addr FIRST (= mutex). EADDRINUSE -> probe; live daemon -> exit, stale -> unlink+retry.
 *   - then start model warmup (non-blocking).
 *   - serialize embeds (one createEmbeddingContext is not assumed reentrant).
 *   - idle TMEM_DAEMON_IDLE_MS (default 15 min) -> close + exit.
 *
 * Address token = sha1(__dirname).slice(12) so a plugin update (new path) yields a
 * new address -> a fresh daemon, while the old one idles out. See addrForDir().
 */
"use strict";

const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const IDLE_MS = parseInt(process.env.TMEM_DAEMON_IDLE_MS || "", 10) || 15 * 60 * 1000;
const MAX_LINE = 64 * 1024; // guard against unbounded buffering

/** Stable token for a directory — same input => same address (client & daemon must agree). */
function tokenForDir(dir) {
  return crypto.createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 12);
}

/** Compute the IPC address for a given directory. */
function addrForDir(dir) {
  const token = tokenForDir(dir);
  if (process.platform === "win32") return `\\\\.\\pipe\\tmem-embed-${token}`;
  return path.join(os.tmpdir(), `tmem-embed-${token}.sock`);
}

/** PID file path so the resident daemon can be found/killed (ops + clean shutdown). */
function pidFileForDir(dir) {
  return path.join(os.tmpdir(), `tmem-embed-${tokenForDir(dir)}.pid`);
}

// ── embed queue: run embeds strictly one at a time ──
let _chain = Promise.resolve();
function enqueueEmbed(embSvc, text) {
  const run = _chain.then(() => embSvc.embed(text));
  // keep the chain alive regardless of individual failures
  _chain = run.then(() => {}, () => {});
  return run;
}

function startDaemon() {
  const addr = addrForDir(__dirname);
  const embSvc = require("./embedding_service.js").getEmbeddingService();

  // lifecycle log — lets us see launch/bind/exit timing (and whether the hook executor reaps us)
  const dbgLog = path.join(os.tmpdir(), `tmem-embed-${tokenForDir(__dirname)}.log`);
  const dbg = (m) => { try { fs.appendFileSync(dbgLog, `${new Date().toISOString()} pid=${process.pid} ${m}\n`); } catch {} };
  dbg("launch");
  process.on("exit", (code) => dbg("exit code=" + code));

  let idleTimer = null;
  const server = net.createServer(onConnection);

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { server.close(); } catch {}
      process.exit(0);
    }, IDLE_MS);
    idleTimer.unref();
  }

  function onConnection(sock) {
    resetIdle();
    sock.setEncoding("utf-8");
    let buf = "";
    let handled = false;
    sock.on("data", (chunk) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_LINE) { sock.destroy(); return; }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      handled = true;
      handleRequest(sock, buf.slice(0, nl));
    });
    sock.on("error", () => {});
  }

  function reply(sock, obj) {
    try { sock.end(JSON.stringify(obj) + "\n"); } catch {}
  }

  function handleRequest(sock, line) {
    let req;
    try { req = JSON.parse(line); } catch { return reply(sock, { error: "badrequest" }); }
    if (!req || req.op !== "embed" || typeof req.text !== "string") {
      return reply(sock, { error: "badrequest" });
    }
    if (embSvc.state === "failed") return reply(sock, { error: "failed" });
    if (!embSvc.isReady()) return reply(sock, { error: "warming" });
    enqueueEmbed(embSvc, req.text).then(
      (vec) => {
        if (!vec) return reply(sock, { error: "failed" });
        reply(sock, { vector: Array.from(vec) });
      },
      () => reply(sock, { error: "failed" })
    );
  }

  const pidfile = pidFileForDir(__dirname);
  function onBound() {
    // bound = mutex held; record pid for ops/shutdown, then warm the model (non-blocking)
    try { fs.writeFileSync(pidfile, String(process.pid)); } catch {}
    process.on("exit", () => { try { fs.unlinkSync(pidfile); } catch {} });
    dbg("bound " + addr);
    embSvc.startWarmup();
    resetIdle();
  }
  function listen() {
    server.listen(addr, onBound);
  }

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      // someone already bound this addr — probe whether it's a live daemon
      const probe = net.connect(addr);
      probe.on("connect", () => { probe.destroy(); process.exit(0); }); // live daemon owns it
      probe.on("error", () => {
        // stale socket (POSIX) / no listener — remove and retry once
        if (process.platform !== "win32") { try { fs.unlinkSync(addr); } catch {} }
        try { server.listen(addr, onBound); }
        catch { process.exit(1); }
      });
      return;
    }
    // any other bind error is a pause-worthy condition; exit non-zero
    process.exit(1);
  });

  listen();
  return { addr, server };
}

// ── CLI ──
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--addr") { console.log(addrForDir(__dirname)); process.exit(0); }
  startDaemon();
}

module.exports = { addrForDir, tokenForDir, pidFileForDir, startDaemon };
