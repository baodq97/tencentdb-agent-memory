"use strict";
// The store root must be overridable, and every module must agree on it.
//
// WHY THIS IS PINNED. The root was spelled out independently in seven modules as
// `path.join(os.homedir(), ".memory-tencentdb")`. Nothing failed, because they
// all agreed — until something needed them to point somewhere else, and then
// there was no lever at all. Concretely: this project's doctrine says to pilot a
// change on a CLONE of the store before trusting it, and that was impossible to
// do; an experiment on the consolidation pipeline had no choice but to write to
// the user's real memory.
//
// The two properties below are what make the override trustworthy, and both have
// a failure mode that is silent rather than loud, which is why they are tests and
// not comments.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ENV = "MEMORY_TENCENTDB_HOME";
function withEnv(value, fn) {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
}

const writer = require("../scripts/memory_writer.js");

test("unset env keeps the historical default", () => {
  withEnv(undefined, () => {
    assert.equal(writer.memoryBaseDir(), path.join(os.homedir(), ".memory-tencentdb"));
  });
});

test("the override is read on EVERY call, not cached at module load", () => {
  // The dangerous version of this feature caches at require() time: a caller that
  // sets the variable after importing gets the real store while believing it is
  // sandboxed, and destroys the user's memory without any error.
  const a = withEnv("/tmp/tmem-root-a", () => writer.memoryBaseDir());
  const b = withEnv("/tmp/tmem-root-b", () => writer.memoryBaseDir());
  assert.equal(a, "/tmp/tmem-root-a");
  assert.equal(b, "/tmp/tmem-root-b");
});

test("empty or whitespace-only is treated as unset, never as the cwd", () => {
  // path.resolve("") is the process cwd, which would scatter a memory store into
  // whichever repository happened to be open.
  for (const v of ["", "   ", "\t"]) {
    withEnv(v, () => {
      assert.equal(writer.memoryBaseDir(), path.join(os.homedir(), ".memory-tencentdb"),
        `${JSON.stringify(v)} must fall back to the default`);
    });
  }
});

test("a relative override is resolved to an absolute path", () => {
  withEnv("some/relative/dir", () => {
    assert.ok(path.isAbsolute(writer.memoryBaseDir()));
  });
});

test("the modules that had their own copy now agree with the one definition", () => {
  // memory_auto_capture, memory_pipeline and memory_reader each carried an
  // independent root. They are the modules on the CAPTURE path — the ones that
  // write — so a disagreement there is what would corrupt a store rather than
  // just misread one.
  withEnv("/tmp/tmem-root-shared", () => {
    const base = writer.memoryBaseDir();
    assert.equal(base, "/tmp/tmem-root-shared");
    assert.ok(writer.globalDir().startsWith(base), "globalDir follows the override");
    assert.ok(writer.projectDir("-x").startsWith(base), "projectDir follows the override");

  });
});

test("auto-capture READS its state from the overridden root", () => {
  // Asserted against a state file this test wrote, not against whatever the real
  // store happens to hold: a test that only checks "not equal to the real value"
  // passes for the wrong reason the moment the real store is empty.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-root-"));
  const hash = "-test-project";
  fs.writeFileSync(path.join(root, "capture_state.json"), JSON.stringify({
    projects: { [hash]: { turn_count: 4242, last_consolidation_turn: 4200, consolidation_due: true } },
  }));
  try {
    withEnv(root, () => {
      delete require.cache[require.resolve("../scripts/memory_auto_capture.js")];
      const cap = require("../scripts/memory_auto_capture.js");
      const st = cap.status(hash);
      assert.equal(st.total_turns, 4242, "read the sandbox state, not the real store");
      assert.equal(st.turns_since_consolidation, 42);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    delete require.cache[require.resolve("../scripts/memory_auto_capture.js")];
  }
});

test("embedding_service resolves the same root without importing the writer", () => {
  // It deliberately reads the env var itself: it is loaded by the resident embed
  // daemon, and importing the writer would drag sqlite into a process whose whole
  // purpose is a small dependency-free start. That duplication is only safe while
  // the two answers match, which is what this asserts.
  const { EmbeddingService } = require("../scripts/embedding_service.js");
  withEnv("/tmp/tmem-root-embed", () => {
    const svc = new EmbeddingService({});
    assert.equal(svc.modelCacheDir, path.join("/tmp/tmem-root-embed", "models"));
  });
  withEnv(undefined, () => {
    const svc = new EmbeddingService({});
    assert.equal(svc.modelCacheDir, path.join(os.homedir(), ".memory-tencentdb", "models"));
  });
});
