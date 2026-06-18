#!/usr/bin/env node
/**
 * GitHub ingest for contributor intelligence. Knows only how to call `gh api`
 * and emit raw JSON. No store knowledge. The gh runner is injectable for tests.
 */
"use strict";

const { spawn } = require("node:child_process");

const BOT_LOGINS = new Set(["dependabot", "renovate", "github-actions", "mergify"]);
const GENERATED = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/,
  /(^|\/)dist\//, /\.min\.js$/, /\.snap$/, /(^|\/)vendor\//,
];

function isNoise(login, filename) {
  if (login && (login.endsWith("[bot]") || BOT_LOGINS.has(login))) return true;
  if (filename && GENERATED.some((re) => re.test(filename))) return true;
  return false;
}

function defaultRunner(args) {
  return new Promise((resolve) => {
    const p = spawn("gh", args, { encoding: "utf8" });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stdout, stderr, headers: {} }));
    p.on("error", () => resolve({ code: 127, stdout: "", stderr: "gh not found", headers: {} }));
  });
}

const nodeSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(res) {
  const s = (res.stderr || "").toLowerCase();
  return res.code !== 0 && (s.includes("rate limit") || s.includes("secondary") || res.headers?.["retry-after"]);
}

async function callWithRetry(runner, args, opts = {}) {
  const sleep = opts.sleep || nodeSleep;
  const maxRetries = opts.maxRetries ?? 3;
  const maxWaitSec = opts.maxWaitSec ?? 120;
  let attempt = 0;
  while (true) {
    const res = await runner(args);
    if (res.code === 0 || !isRateLimit(res)) return res;
    if (attempt >= maxRetries) throw new Error("rate limit: retries exhausted");
    let waitSec;
    const h = res.headers || {};
    if (h["retry-after"]) waitSec = parseInt(h["retry-after"], 10);
    else waitSec = Math.pow(2, attempt + 1); // exponential backoff
    waitSec = Math.min(waitSec, maxWaitSec);
    process.stderr.write(`[contrib] rate limited, waiting ~${waitSec}s for GitHub reset...\n`);
    await sleep(waitSec * 1000);
    attempt += 1;
  }
}

async function ghJson(runner, args, opts) {
  const res = await callWithRetry(runner, args, opts);
  if (res.code !== 0) return [];
  try { return JSON.parse(res.stdout || "[]"); } catch { return []; }
}

async function fetchRaw(subject, opts = {}) {
  const runner = opts.runner || defaultRunner;
  const { repo, max_prs = 100 } = subject;
  const prsRaw = await ghJson(runner, [
    "api", `/repos/${repo}/pulls?state=all&per_page=${Math.min(max_prs, 100)}`,
  ], opts);
  const commitsRaw = await ghJson(runner, ["api", `/repos/${repo}/commits`], opts);

  const prs = (prsRaw || []).filter((p) => !isNoise(p.user?.login, null));
  const commits = (commitsRaw || []).filter((c) => !isNoise(c.author?.login, null));

  return { commits, prs, reviewComments: [], issues: [] };
}

module.exports = { fetchRaw, isNoise, callWithRetry };
