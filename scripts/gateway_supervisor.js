#!/usr/bin/env node
/**
 * Discover, start, and stop the memory-tencentdb Gateway Node.js sidecar.
 *
 * Usage:
 *   node scripts/gateway_supervisor.js start
 *   node scripts/gateway_supervisor.js stop
 *   node scripts/gateway_supervisor.js status
 */
"use strict";

const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { GatewayClient } = require("./gateway_client.js");

const STATE_DIR = path.join(os.homedir(), ".memory-tencentdb");
const PID_FILE = path.join(STATE_DIR, "gateway.pid");
const LOG_DIR = path.join(STATE_DIR, "logs");
const STDOUT_LOG = path.join(LOG_DIR, "gateway.stdout.log");
const STDERR_LOG = path.join(LOG_DIR, "gateway.stderr.log");

const HEALTH_INTERVAL = 500;
const HEALTH_MAX_WAIT = 30000;

function discoverServerTs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".memory-tencentdb", "tdai-memory-openclaw-plugin", "src", "gateway", "server.ts"),
    path.join(home, "tdai-memory-openclaw-plugin", "src", "gateway", "server.ts"),
    path.join(home, ".hermes", "plugins", "tdai-memory-openclaw-plugin", "src", "gateway", "server.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveCommand() {
  const envCmd = (process.env.MEMORY_TENCENTDB_GATEWAY_CMD || "").trim();
  if (envCmd) return envCmd;
  const serverTs = discoverServerTs();
  if (serverTs) return `node --import tsx "${serverTs}"`;
  return null;
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function start() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const client = new GatewayClient();
  try {
    const h = await client.health(2000);
    console.log("gateway already healthy:", JSON.stringify(h));
    return 0;
  } catch {}

  const cmd = resolveCommand();
  if (!cmd) {
    console.error("ERROR: cannot locate Gateway. Set MEMORY_TENCENTDB_GATEWAY_CMD or run /memory-init.");
    return 2;
  }

  const stdoutFd = fs.openSync(STDOUT_LOG, "a");
  const stderrFd = fs.openSync(STDERR_LOG, "a");

  const parts = cmd.split(/\s+/);
  const proc = spawn(parts[0], parts.slice(1), {
    stdio: ["ignore", stdoutFd, stderrFd],
    detached: true,
    shell: process.platform === "win32",
  });
  proc.unref();
  fs.writeFileSync(PID_FILE, String(proc.pid), "utf-8");
  console.log(`spawned gateway pid=${proc.pid}, waiting for /health...`);

  const deadline = Date.now() + HEALTH_MAX_WAIT;
  while (Date.now() < deadline) {
    try {
      const h = await client.health(2000);
      if (h.status === "ok" || h.status === "degraded") {
        console.log("gateway ready:", JSON.stringify(h));
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
        return 0;
      }
    } catch {}
    await sleep(HEALTH_INTERVAL);
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  console.error("ERROR: gateway failed to become healthy within timeout");
  return 4;
}

function stop() {
  const pid = readPid();
  if (!pid) { console.log("no pid file; nothing to stop"); return 0; }
  if (!pidAlive(pid)) {
    console.log(`pid ${pid} already exited`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    return 0;
  }
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    console.log(`sent stop signal to pid ${pid}`);
  } catch (e) {
    console.error(`failed to signal pid ${pid}:`, e.message);
    return 1;
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  return 0;
}

async function status() {
  const pid = readPid();
  const client = new GatewayClient();
  let health;
  try { health = await client.health(2000); } catch (e) { health = { status: "down", error: e.message }; }
  console.log(JSON.stringify({ pid, alive: !!(pid && pidAlive(pid)), health }, null, 2));
  return 0;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) { console.error("usage: gateway_supervisor.js start|stop|status"); process.exit(64); }
  if (cmd === "start") process.exit(await start());
  if (cmd === "stop") process.exit(stop());
  if (cmd === "status") process.exit(await status());
  console.error(`unknown subcommand: ${cmd}`);
  process.exit(64);
}

main();
