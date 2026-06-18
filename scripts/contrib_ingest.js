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
  const { repo, github_user, max_prs = 100 } = subject;
  const perPage = Math.min(max_prs, 100);
  // Incremental: when a cursor is supplied, only pull activity updated since it.
  const since = opts.since || null;
  const updatedQ = since ? `+updated:>=${since.slice(0, 10)}` : "";
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";

  // PRs authored BY this subject — the pulls endpoint has no author filter,
  // so use the search API (returns {items:[...]}). Search spans all branches.
  const searchRaw = await ghJson(runner, [
    "api", `/search/issues?q=repo:${repo}+type:pr+author:${github_user}${updatedQ}&per_page=${perPage}`,
  ], opts);
  const prItems = Array.isArray(searchRaw) ? searchRaw : (searchRaw?.items || []);
  const prs = (prItems || []).filter((p) => !isNoise(p.user?.login, null));

  // Issues the subject OPENED — source for the `idea` dimension (framing,
  // repro, root-cause-vs-symptom).
  const issuesRaw = await ghJson(runner, [
    "api", `/search/issues?q=repo:${repo}+type:issue+author:${github_user}${updatedQ}&per_page=${perPage}`,
  ], opts);
  const issueItems = Array.isArray(issuesRaw) ? issuesRaw : (issuesRaw?.items || []);
  const issues = (issueItems || [])
    .filter((i) => !isNoise(i.user?.login, null))
    .map((i) => ({ number: i.number, title: i.title, body: i.body }));

  // Commits ACROSS ALL BRANCHES, deduped by sha:
  //  (a) direct commits on the default branch (?author=), plus
  //  (b) commits on each PR's head branch (/pulls/<n>/commits) — these live on
  //      feature branches and are missed by the default-branch listing.
  const bySha = new Map();
  const defaultCommits = await ghJson(runner, [
    "api", `/repos/${repo}/commits?author=${github_user}&per_page=${perPage}${sinceParam}`,
  ], opts);
  for (const c of defaultCommits || []) {
    if (c.sha && !isNoise(c.author?.login, null)) bySha.set(c.sha, c);
  }

  // Review threads RECEIVED on the subject's own PRs (conflict / how they respond).
  const reviewThreadsReceived = [];
  for (const pr of prs) {
    const prCommits = await ghJson(runner, [
      "api", `/repos/${repo}/pulls/${pr.number}/commits?per_page=100`,
    ], opts);
    for (const c of prCommits || []) {
      if (!c.sha) continue;
      if (isNoise(c.author?.login, null)) continue;
      if (c.author?.login && c.author.login !== github_user) continue; // subject's own commits
      bySha.set(c.sha, c);
    }
    // inline review comments (on the diff) + PR conversation comments (issues API)
    const prComments = await ghJson(runner, [
      "api", `/repos/${repo}/pulls/${pr.number}/comments?per_page=100`,
    ], opts);
    const convComments = await ghJson(runner, [
      "api", `/repos/${repo}/issues/${pr.number}/comments?per_page=100`,
    ], opts);
    for (const c of [...(prComments || []), ...(convComments || [])]) {
      if (isNoise(c.user?.login, null)) continue;
      reviewThreadsReceived.push({
        pr: pr.number, author: c.user?.login,
        is_subject: c.user?.login === github_user, body: c.body, path: c.path || null,
      });
    }
  }
  const commits = [...bySha.values()];

  // Review comments the subject WROTE on others' PRs (craft / mentor).
  // The repo-wide endpoint has no author filter, so page through it (bounded by
  // maxCommentPages) and keep only this subject's comments.
  const maxCommentPages = opts.maxCommentPages ?? 5;
  const reviewCommentsGiven = [];
  for (let page = 1; page <= maxCommentPages; page += 1) {
    const batch = await ghJson(runner, [
      "api", `/repos/${repo}/pulls/comments?per_page=100&sort=created&direction=desc&page=${page}`,
    ], opts);
    if (!batch || batch.length === 0) break;
    for (const c of batch) {
      if (c.user?.login === github_user) {
        reviewCommentsGiven.push({ pr: prNumberFromUrl(c.pull_request_url), body: c.body, path: c.path, created_at: c.created_at });
      }
    }
    if (batch.length < 100) break; // last page
  }

  return { commits, prs, reviewCommentsGiven, reviewThreadsReceived, issues };
}

function prNumberFromUrl(url) {
  const m = /\/pulls\/(\d+)/.exec(url || "");
  return m ? parseInt(m[1], 10) : null;
}

const CONV_PREFIX = /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\([^)]+\))?:|^[a-z][\w.-]*:/;

// Deterministic trajectory: bucket the subject's activity by year so the
// evolution arc (cadence + commit style + shift toward review) is visible.
// v1 measures cadence and style, NOT PR LOC (search API omits diff size).
function computeTrajectory(raw) {
  const byYear = new Map();
  const bucket = (y) => {
    if (!byYear.has(y)) byYear.set(y, { year: y, commits: 0, prs: 0, reviewsGiven: 0, _subjLen: 0, _conv: 0 });
    return byYear.get(y);
  };
  const yearOf = (iso) => (iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null);

  for (const c of raw.commits || []) {
    const y = yearOf(c.commit?.author?.date);
    if (!y) continue;
    const b = bucket(y);
    b.commits += 1;
    const subj = (c.commit?.message || "").split("\n")[0];
    b._subjLen += subj.length;
    if (CONV_PREFIX.test(subj)) b._conv += 1;
  }
  for (const p of raw.prs || []) {
    const y = yearOf(p.created_at);
    if (y) bucket(y).prs += 1;
  }
  for (const r of raw.reviewCommentsGiven || []) {
    const y = yearOf(r.created_at);
    if (y) bucket(y).reviewsGiven += 1;
  }

  return [...byYear.values()]
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((b) => ({
      year: b.year,
      commits: b.commits,
      prs: b.prs,
      reviewsGiven: b.reviewsGiven,
      avgSubjectLen: b.commits ? Math.round(b._subjLen / b.commits) : 0,
      convPrefixPct: b.commits ? Math.round((b._conv / b.commits) * 100) : 0,
    }));
}

module.exports = { fetchRaw, isNoise, callWithRetry, prNumberFromUrl, computeTrajectory };
