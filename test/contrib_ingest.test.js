// test/contrib_ingest.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fetchRaw, isNoise, callWithRetry } = require("../scripts/contrib_ingest.js");

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

test("fetchRaw drops bot PRs via noise filter", async () => {
  const runner = fakeRunner({
    "/pulls": { code: 0, stdout: prs, stderr: "", headers: {} },
    "/commits": { code: 0, stdout: commits, stderr: "", headers: {} },
  });
  const raw = await fetchRaw(
    { id: "mitchellh@x", github_user: "mitchellh", repo: "o/x", since: "2023-01-01", max_prs: 100 },
    { runner, sleep: async () => {}, maxRetries: 3, maxWaitSec: 120 }
  );
  assert.strictEqual(raw.prs.length, 1);          // dependabot[bot] dropped
  assert.strictEqual(raw.prs[0].number, 1234);
});
