#!/usr/bin/env node
/**
 * tmem launcher — resolves the CORRECT plugin version at runtime, so the global
 * `tmem` command never drifts behind the installed/loaded plugin again.
 *
 * Resolution order:
 *   1. $CLAUDE_PLUGIN_ROOT/scripts/cli.js  — the version Claude Code actually
 *      loaded (set for hooks/skills); this is the agent/Claude-Code self-resolve path.
 *   2. newest version under the plugin cache — for a human typing `tmem` in a
 *      plain terminal where no plugin env is present.
 *   3. sibling cli.js next to this launcher — last-resort fallback.
 *
 * Version-independent on purpose: even a stale copy of this launcher self-corrects.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** Numeric semver-ish comparison: "0.10.0" > "0.4.2" > "0.4.10" > "0.2.3". */
function compareSemver(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function defaultCacheDir() {
  return path.join(
    os.homedir(), ".claude", "plugins", "cache",
    "tencentdb-agent-memory", "tencentdb-agent-memory",
  );
}

/**
 * Resolve the absolute path to the cli.js that should handle this invocation.
 * @param {{pluginRoot?: string, cacheDir?: string}} [opts] overrides for testing
 * @returns {string|null}
 */
function resolveCliPath(opts = {}) {
  const pluginRoot = "pluginRoot" in opts ? opts.pluginRoot : process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const p = path.join(pluginRoot, "scripts", "cli.js");
    if (fs.existsSync(p)) return p;
  }

  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  try {
    // Only version-shaped dirs (drops `.DS_Store`, `latest`, partial installs).
    // NB: prerelease ordering (e.g. 1.0.0-beta.1) is not SemVer-correct, but this
    // project ships plain x.y.z releases so it never matters in practice.
    const versions = fs.readdirSync(cacheDir)
      .filter((v) => /^\d+\.\d+\.\d+/.test(v) && fs.existsSync(path.join(cacheDir, v, "scripts", "cli.js")))
      .sort(compareSemver);
    if (versions.length) {
      return path.join(cacheDir, versions[versions.length - 1], "scripts", "cli.js");
    }
  } catch { /* cache absent → fall through */ }

  const sibling = path.join(__dirname, "cli.js");
  if (fs.existsSync(sibling)) return sibling;

  return null;
}

/** Recognize a `tmem` file that this plugin owns (current launcher or an old shim). */
function isOurShim(content) {
  return content.includes("tmem launcher") // this launcher's header marker
    || content.includes(".claude/plugins/cache/tencentdb-agent-memory"); // legacy hardcoded shim
}

/**
 * Keep a `tmem` shim in binDir pointing at the current launcher. Idempotent and
 * SAFE: installs when missing, refreshes a stale shim of OURS, and NEVER clobbers
 * a foreign file the user owns. Best-effort — returns a result, never throws.
 * @returns {{action: 'installed'|'updated'|'skipped-current'|'skipped-foreign'|'error', target: string, error?: string}}
 */
function ensureLauncherInstalled(opts = {}) {
  const sourceFile = opts.sourceFile ?? path.join(__dirname, "tmem.js");
  const binDir = opts.binDir ?? path.join(os.homedir(), ".local", "bin");
  const target = path.join(binDir, "tmem");
  try {
    const source = fs.readFileSync(sourceFile, "utf-8");
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, "utf-8");
      if (existing === source) return { action: "skipped-current", target };
      if (!isOurShim(existing)) return { action: "skipped-foreign", target };
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(target, source);
      fs.chmodSync(target, 0o755);
      return { action: "updated", target };
    }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(target, source);
    fs.chmodSync(target, 0o755);
    return { action: "installed", target };
  } catch (e) {
    return { action: "error", target, error: e && e.message };
  }
}

if (require.main === module) {
  const cli = resolveCliPath();
  if (!cli) {
    console.error("tmem: cannot locate the plugin's cli.js — is the tencentdb-agent-memory plugin installed? Try /memory-init.");
    process.exit(1);
  }
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error) {
    console.error(`tmem: failed to launch cli.js: ${r.error.message}`);
    process.exit(1);
  }
  if (r.signal) process.exit(1); // child killed by signal → don't report success
  process.exit(r.status ?? 0);
}

module.exports = { resolveCliPath, compareSemver, defaultCacheDir, ensureLauncherInstalled, isOurShim };
