// test/contrib_ingest.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fetchRaw, isNoise, callWithRetry, computeTrajectory } = require("../scripts/contrib_ingest.js");

const FIX = path.join(__dirname, "fixtures", "contrib");
const prs = fs.readFileSync(path.join(FIX, "prs.json"), "utf8");
const commits = fs.readFileSync(path.join(FIX, "commits.json"), "utf8");

function fakeRunner(map) {
  // map: substring-of-endpoint -> {code, stdout, stderr, headers}
  return async (args) => {
    const endpoint = args.join(" ");
    for (const key of Object.keys(map)) {
      if (endpoint.includes(key)) return map[key];
    }
    return { code: 0, stdout: "[]", stderr: "", headers: {} };
  };
}

test("isNoise flags bots and generated files", () => {
  assert.strictEqual(isNoise("dependabot[bot]", "src/a.js"), true);
  assert.strictEqual(isNoise("mitchellh", "package-lock.json"), true);
  assert.strictEqual(isNoise("mitchellh", "dist/bundle.js"), true);
  assert.strictEqual(isNoise("mitchellh", "src/client.js"), false);
});

test("callWithRetry waits then succeeds on rate limit", async () => {
  let calls = 0;
  const slept = [];
  const runner = async () => {
    calls += 1;
    if (calls === 1) return { code: 1, stdout: "", stderr: "API rate limit exceeded", headers: { "retry-after": "2" } };
    return { code: 0, stdout: "[]", stderr: "", headers: {} };
  };
  const res = await callWithRetry(runner, ["api", "x"], { sleep: (ms) => { slept.push(ms); }, maxRetries: 3, maxWaitSec: 120 });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(slept, [2000]); // retry-after seconds → ms
});

test("callWithRetry caps wait and gives up after maxRetries", async () => {
  const runner = async () => ({ code: 1, stdout: "", stderr: "secondary rate limit", headers: {} });
  await assert.rejects(
    callWithRetry(runner, ["api", "x"], { sleep: async () => {}, maxRetries: 2, maxWaitSec: 5 }),
    /retries exhausted/
  );
});

test("fetchRaw scopes by author and drops bot PRs via noise filter", async () => {
  const seen = [];
  const searchResult = JSON.stringify({ items: JSON.parse(prs) });
  const runner = async (args) => {
    seen.push(args.join(" "));
    const ep = args.join(" ");
    if (ep.includes("/search/issues")) return { code: 0, stdout: searchResult, stderr: "", headers: {} };
    if (ep.includes("/commits")) return { code: 0, stdout: commits, stderr: "", headers: {} };
    return { code: 0, stdout: "[]", stderr: "", headers: {} };
  };
  const raw = await fetchRaw(
    { id: "mitchellh@x", github_user: "mitchellh", repo: "o/x", since: "2023-01-01", max_prs: 100 },
    { runner, sleep: async () => {}, maxRetries: 3, maxWaitSec: 120 }
  );
  assert.strictEqual(raw.prs.length, 1);          // dependabot[bot] dropped
  assert.strictEqual(raw.prs[0].number, 1234);
  // requests must be scoped to the subject's author, not repo-wide
  assert.ok(seen.some((e) => e.includes("author:mitchellh")), "PR search scoped by author");
  assert.ok(seen.some((e) => e.includes("/commits?author=mitchellh")), "default-branch commits scoped by author");
  assert.ok(seen.some((e) => e.includes("/pulls/1234/commits")), "per-PR (cross-branch) commits fetched");
});

test("computeTrajectory buckets activity by year and tracks style evolution", () => {
  const raw = {
    commits: [
      { commit: { message: "stuff happened", author: { date: "2021-03-01T00:00:00Z" } } },
      { commit: { message: "feat: add thing", author: { date: "2024-05-01T00:00:00Z" } } },
      { commit: { message: "fix(core): guard edge", author: { date: "2024-06-01T00:00:00Z" } } },
    ],
    prs: [
      { created_at: "2021-03-02T00:00:00Z" },
      { created_at: "2024-05-02T00:00:00Z" },
    ],
    reviewCommentsGiven: [
      { created_at: "2024-07-01T00:00:00Z" },
      { created_at: "2024-08-01T00:00:00Z" },
    ],
  };
  const traj = computeTrajectory(raw);
  assert.strictEqual(traj.length, 2);
  const [y2021, y2024] = traj;
  assert.strictEqual(y2021.year, "2021");
  assert.strictEqual(y2021.commits, 1);
  assert.strictEqual(y2021.convPrefixPct, 0);     // "stuff happened" not conventional
  assert.strictEqual(y2024.commits, 2);
  assert.strictEqual(y2024.convPrefixPct, 100);   // both conventional
  assert.strictEqual(y2024.reviewsGiven, 2);      // shift toward review in later year
});

test("fetchRaw collects issues the subject opened", async () => {
  const prSearch = JSON.stringify({ items: JSON.parse(prs) });
  const issueSearch = JSON.stringify({ items: [
    { number: 700, title: "Crash on resize past scrollback", body: "Repro: ...", user: { login: "mitchellh" } },
    { number: 701, title: "bot noise", body: "", user: { login: "dependabot[bot]" } },
  ] });
  const runner = async (args) => {
    const ep = args.join(" ");
    if (ep.includes("type:issue")) return { code: 0, stdout: issueSearch, stderr: "", headers: {} };
    if (ep.includes("/search/issues")) return { code: 0, stdout: prSearch, stderr: "", headers: {} };
    if (ep.includes("/commits")) return { code: 0, stdout: commits, stderr: "", headers: {} };
    return { code: 0, stdout: "[]", stderr: "", headers: {} };
  };
  const raw = await fetchRaw(
    { id: "mitchellh@x", github_user: "mitchellh", repo: "o/x", max_prs: 100 },
    { runner, sleep: async () => {}, maxRetries: 3, maxWaitSec: 120 }
  );
  assert.strictEqual(raw.issues.length, 1);        // bot issue dropped
  assert.strictEqual(raw.issues[0].number, 700);
});

test("fetchRaw collects review comments given and threads received", async () => {
  const searchResult = JSON.stringify({ items: JSON.parse(prs) });
  const givenComments = JSON.stringify([
    { user: { login: "mitchellh" }, body: "Nit: prefer a deep module here — this leaks the buffer detail.", path: "src/a.zig", pull_request_url: "https://api.github.com/repos/o/x/pulls/55" },
    { user: { login: "someoneelse" }, body: "lgtm", path: "src/b.zig", pull_request_url: "https://api.github.com/repos/o/x/pulls/55" },
  ]);
  const receivedComments = JSON.stringify([
    { user: { login: "reviewerA" }, body: "Could this overflow on resize?", path: "src/c.zig" },
    { user: { login: "mitchellh" }, body: "Good catch — guarding the wrap count now.", path: "src/c.zig" },
  ]);
  const runner = async (args) => {
    const ep = args.join(" ");
    if (ep.includes("/search/issues")) return { code: 0, stdout: searchResult, stderr: "", headers: {} };
    if (ep.includes("/pulls/comments")) return { code: 0, stdout: givenComments, stderr: "", headers: {} };
    if (ep.includes("/pulls/1234/comments")) return { code: 0, stdout: receivedComments, stderr: "", headers: {} };
    if (ep.includes("/commits")) return { code: 0, stdout: commits, stderr: "", headers: {} };
    return { code: 0, stdout: "[]", stderr: "", headers: {} };
  };
  const raw = await fetchRaw(
    { id: "mitchellh@x", github_user: "mitchellh", repo: "o/x", since: "2023-01-01", max_prs: 100 },
    { runner, sleep: async () => {}, maxRetries: 3, maxWaitSec: 120 }
  );
  // given: only mitchellh's comment kept, PR number parsed from url
  assert.strictEqual(raw.reviewCommentsGiven.length, 1);
  assert.strictEqual(raw.reviewCommentsGiven[0].pr, 55);
  // received: both reviewerA and mitchellh's reply on PR #1234, tagged is_subject
  assert.strictEqual(raw.reviewThreadsReceived.length, 2);
  const reply = raw.reviewThreadsReceived.find((t) => t.is_subject);
  assert.ok(reply && reply.author === "mitchellh");
});
