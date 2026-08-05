"use strict";
// `tmem version` — lets an agent (and a human) discover which CLI version is
// actually resolved and running, so version drift is diagnosable in one call
// instead of guessing. `--version`/`-v` are aliases.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const VERSION = require("../package.json").version;

function run(args) {
  return execFileSync("node", [CLI, ...args], { encoding: "utf-8" });
}

test("`version` prints the package version on the first line", () => {
  const out = run(["version"]);
  assert.match(out, new RegExp(`^tmem ${VERSION.replace(/\./g, "\\.")}\\b`, "m"));
});

test("`--version` and `-v` are aliases (not 'Unknown command')", () => {
  for (const flag of ["--version", "-v"]) {
    const out = run([flag]);
    assert.ok(out.includes(`tmem ${VERSION}`), `${flag} should print the version`);
    assert.doesNotMatch(out, /Unknown command/);
  }
});

test("`version` reports the resolved cli path and node version for drift diagnosis", () => {
  const out = run(["version"]);
  assert.match(out, /cli:/);
  assert.match(out, /node:\s*v\d+/);
});
