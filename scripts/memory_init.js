#!/usr/bin/env node
/**
 * Initialize local memory store: dirs, FTS5 indexes, vector indexes.
 * Reindexes existing records into vectors.db if embedding is available.
 *
 * Usage:
 *   node scripts/memory_init.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MemoryStore } = require("./memory_store.js");
const { VectorStore } = require("./vector_store.js");
const { globalDir, projectDir } = require("./memory_writer.js");
const { projectHashForCwd } = require("./memory_reader.js");

async function main() {
  const gDir = globalDir();
  const cwd = process.env.CLAUDE_PROJECT_DIR || ".";
  const pHash = projectHashForCwd(cwd);
  const pDir = projectDir(pHash);

  fs.mkdirSync(gDir, { recursive: true });
  fs.mkdirSync(pDir, { recursive: true });

  for (const dir of [gDir, pDir]) {
    const store = new MemoryStore(path.join(dir, "index.db"));
    store.close();
  }

  let vecOk = true;
  for (const dir of [gDir, pDir]) {
    const vs = new VectorStore(path.join(dir, "vectors.db"));
    if (vs.degraded) vecOk = false;
    vs.close();
  }

  let totalRecords = 0;
  for (const dir of [gDir, pDir]) {
    const store = new MemoryStore(path.join(dir, "index.db"));
    totalRecords += store.count();
    store.close();
  }

  console.log("Global dir:", gDir);
  console.log("Project dir:", pDir, "(" + pHash + ")");
  console.log("FTS5: ready");
  console.log("Vector store:", vecOk ? "ready" : "degraded (sqlite-vec failed)");
  console.log("Existing records:", totalRecords);

  if (totalRecords > 0 && vecOk) {
    console.log("\nReindexing existing records into vector store...");
    try {
      const { getEmbeddingService } = require("./embedding_service.js");
      const svc = getEmbeddingService();
      svc.startWarmup();
      await svc.waitForReady();
      if (svc.isReady()) {
        for (const dir of [gDir, pDir]) {
          const dbPath = path.join(dir, "index.db");
          if (!fs.existsSync(dbPath)) continue;
          const ftsStore = new MemoryStore(dbPath);
          const records = ftsStore.allRecords("", 10000);
          ftsStore.close();
          if (!records.length) continue;
          const vecStore = new VectorStore(path.join(dir, "vectors.db"));
          if (vecStore.degraded) continue;
          let count = 0;
          for (const r of records) {
            const vec = await svc.embed(r.content);
            if (vec) { vecStore.upsertVec(r.record_id, vec); count++; }
          }
          vecStore.close();
          if (count) console.log("Indexed", count, "records in", dir === gDir ? "global" : "project");
        }
        svc.close();
        console.log("Vector index ready.");
      } else {
        console.log("Embedding not available, skipping vector index.");
      }
    } catch {
      console.log("Embedding not available, skipping vector index.");
    }
  }

  console.log("\nNext: run /memory-seed to extract memories from past conversations.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
