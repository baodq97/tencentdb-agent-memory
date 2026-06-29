"use strict";
// migrate-fragments collapses legacy cwd-keyed fragment stores into their project root:
// records (id-deduped) + scenes (newer wins) move to the root store, and the fragment is
// ARCHIVED (never deleted). Dry-run by default; --apply executes.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const WRITER = path.join(__dirname, "..", "scripts", "memory_writer.js");

function rawSlug(p) { return path.resolve(p).replace(/:/g, "-").replace(/[\\/]/g, "-"); }

function withEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

// Seed a store dir directly via the writer primitives (bypasses the new keying so we can
// fabricate a *legacy* fragment store), running under the fake HOME.
function seedStore(home, slug, { atomId, content, scene }) {
  const script = `
    const w = require(${JSON.stringify(WRITER)});
    const dir = w.projectDir(${JSON.stringify(slug)});
    w.writeL1Record(dir, { id: ${JSON.stringify(atomId)}, content: ${JSON.stringify(content)}, type: "episodic", priority: 50 });
    ${scene ? `w.writeSceneBlock(dir, ${JSON.stringify(scene.name)}, ${JSON.stringify(scene.summary)}, ${JSON.stringify(scene.content)}, ${scene.heat});` : ""}
  `;
  execFileSync("node", ["-e", script], { env: withEnv(home), encoding: "utf-8" });
}

function run(home, args) {
  return execFileSync("node", [CLI, ...args], { env: withEnv(home), encoding: "utf-8" });
}

test("merges a subdir fragment into its git root and archives the fragment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-mig-home-"));
  try {
    // a real git repo at <home>/proj, with a subdir
    const repo = path.join(home, "proj");
    fs.mkdirSync(path.join(repo, "svc"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });

    const rootSlug = rawSlug(repo);            // proj has .git → its own root
    const fragSlug = rawSlug(path.join(repo, "svc")); // legacy subdir store

    seedStore(home, fragSlug, {
      atomId: "frag_1", content: "fragment subdir atom about widgets",
      scene: { name: "frag-scene", summary: "a stranded scene", heat: 4, content: "## body\nstranded content" },
    });

    // dry-run must NOT move anything
    const dry = run(home, ["migrate-fragments"]);
    assert.match(dry, /dry-run/);
    assert.match(dry, new RegExp(`${fragSlug}[\\s\\S]*→ ${rootSlug}`));
    const base = path.join(home, ".memory-tencentdb", "projects");
    assert.ok(fs.existsSync(path.join(base, fragSlug)), "dry-run wrongly moved the fragment");

    // apply
    run(home, ["migrate-fragments", "--apply"]);

    // fragment archived, not deleted
    assert.ok(!fs.existsSync(path.join(base, fragSlug)), "fragment store still present after apply");
    assert.ok(fs.existsSync(path.join(home, ".memory-tencentdb", ".migrated", fragSlug)), "fragment not archived");

    // record + scene landed in the root store
    const search = run(home, ["search", "widgets", "--project", rootSlug]);
    assert.match(search, /fragment subdir atom about widgets/, "record did not reach the root store");
    const scenePath = path.join(base, rootSlug, "scene_blocks", "frag-scene.md");
    assert.ok(fs.existsSync(scenePath), "scene did not reach the root store");
    assert.match(fs.readFileSync(scenePath, "utf-8"), /stranded content/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("idempotent: a second --apply is a no-op (nothing left to migrate)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-mig-home2-"));
  try {
    const repo = path.join(home, "proj");
    fs.mkdirSync(path.join(repo, "svc"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    seedStore(home, rawSlug(path.join(repo, "svc")), { atomId: "a1", content: "one atom" });

    run(home, ["migrate-fragments", "--apply"]);
    const second = run(home, ["migrate-fragments"]);
    assert.match(second, /No fragments to migrate/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
