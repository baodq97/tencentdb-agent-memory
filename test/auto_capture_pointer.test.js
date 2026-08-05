"use strict";
// WS5 — capture records the real transcript source uuids + an L0 pointer, fixing
// the measured-dead cross-layer link (source_message_ids was always []). Runs in
// a child process with an isolated HOME so it can never touch the real store.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPTS = path.join(__dirname, "..", "scripts");

test("autoCapture stores source_message_ids + L0 pointer", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-cap-"));
  try {
    const prog = `
      const { autoCapture } = require(${JSON.stringify(path.join(SCRIPTS, "memory_auto_capture.js"))});
      const { projectHashForCwd } = require(${JSON.stringify(path.join(SCRIPTS, "memory_reader.js"))});
      const fs = require("node:fs");
      const path = require("node:path");
      const cwd = process.env.HOME;
      autoCapture({
        userText: "Please design the two-clock recall pipeline and measure the redundancy on the real store.",
        assistantText: "Done, redundancy dropped to zero.",
        sessionId: "sess-1", cwd,
        sourceMessageIds: ["u-uuid", "a-uuid"], gitBranch: "main",
        transcriptPath: "/x/y.jsonl",
      });
      const hash = projectHashForCwd(cwd);
      // The durable record store is the JSONL shard (SQLite is just the search
      // index and doesn't carry source_message_ids) — read the link from there.
      const recordsDir = path.join(process.env.HOME, ".memory-tencentdb", "projects", hash, "records");
      const shard = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".jsonl"))[0];
      const lines = fs.readFileSync(path.join(recordsDir, shard), "utf-8").trim().split("\\n");
      const rec = JSON.parse(lines[lines.length - 1]);
      process.stdout.write(JSON.stringify({ sids: rec.source_message_ids, meta: rec.metadata }));
    `;
    const out = execFileSync("node", ["-e", prog], {
      env: { ...process.env, HOME: home },
      encoding: "utf-8",
    });
    const { sids, meta } = JSON.parse(out);
    assert.deepStrictEqual(sids, ["u-uuid", "a-uuid"], "source_message_ids must carry the real uuids");
    assert.strictEqual(meta.pointer.lastUuid, "a-uuid");
    assert.strictEqual(meta.pointer.gitBranch, "main");
    assert.strictEqual(meta.pointer.transcriptPath, "/x/y.jsonl");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
