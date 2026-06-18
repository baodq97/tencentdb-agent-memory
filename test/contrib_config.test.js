// test/contrib_config.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, addSubject, addTeamMembers, getTeam } = require("../scripts/contrib_config.js");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ccfg-")); }

test("loadConfig returns defaults when file missing", () => {
  const cfg = loadConfig(tmpDir());
  assert.deepStrictEqual(cfg.subjects, []);
  assert.strictEqual(cfg.l4.prevalence_threshold, 0.6);
  assert.strictEqual(cfg.ingest.max_retries, 3);
});

test("addSubject validates repo and derives id", () => {
  const dir = tmpDir();
  const s = addSubject(dir, { github_user: "mitchellh", repo: "ghostty-org/ghostty", since: "2023-01-01" });
  assert.strictEqual(s.id, "mitchellh@ghostty");
  assert.strictEqual(loadConfig(dir).subjects.length, 1);
});

test("addSubject rejects bad repo and duplicates", () => {
  const dir = tmpDir();
  assert.throws(() => addSubject(dir, { github_user: "x", repo: "no-slash" }), /invalid repo/);
  addSubject(dir, { github_user: "mitchellh", repo: "ghostty-org/ghostty" });
  assert.throws(() => addSubject(dir, { github_user: "mitchellh", repo: "ghostty-org/ghostty" }), /duplicate subject/);
});

test("addTeamMembers groups known subjects and rejects unknown", () => {
  const dir = tmpDir();
  addSubject(dir, { github_user: "a", repo: "o/x" });
  addSubject(dir, { github_user: "b", repo: "o/y" });
  const t = addTeamMembers(dir, "core", ["a@x", "b@y"]);
  assert.deepStrictEqual(t.members, ["a@x", "b@y"]);
  assert.strictEqual(getTeam(dir, "core").members.length, 2);
  // idempotent add, no dupes
  addTeamMembers(dir, "core", ["a@x"]);
  assert.strictEqual(getTeam(dir, "core").members.length, 2);
  assert.throws(() => addTeamMembers(dir, "core", ["ghost@z"]), /unknown subject/);
});
