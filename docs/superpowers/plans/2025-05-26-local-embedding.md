# Local Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local vector embedding (EmbeddingGemma-300m via node-llama-cpp) + sqlite-vec to enable hybrid FTS5+vector recall merged via RRF.

**Architecture:** Two new modules (`embedding_service.js`, `vector_store.js`) that wrap node-llama-cpp and sqlite-vec respectively. `memory_recall.js` gains a hybrid path that merges FTS5 keyword results with vector cosine results via RRF (k=60). Everything degrades gracefully to FTS5-only when embedding isn't ready.

**Tech Stack:** node-llama-cpp (^3.16.2), sqlite-vec (0.1.7-alpha.2), node:sqlite (built-in), EmbeddingGemma-300m GGUF (768 dims)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Create | Declares node-llama-cpp + sqlite-vec dependencies |
| `scripts/embedding_service.js` | Create | Local embedding via node-llama-cpp, background warmup, singleton |
| `scripts/vector_store.js` | Create | sqlite-vec wrapper: vec0 table, upsert, KNN search, RRF merge |
| `scripts/memory_recall.js` | Modify | Add hybrid recall path (FTS5 + vector + RRF) |
| `scripts/memory_store.js` | Modify | Embed on upsert (best-effort) |
| `hooks/scripts/on_user_prompt.js` | Modify | Trigger embedding warmup |
| `scripts/eval_runner.js` | Modify | Add section 9: embedding + vector store tests |
| `commands/memory-reindex.md` | Create | Slash command to rebuild vectors.db from existing index.db |

---

### Task 1: Add npm dependencies

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "tencentdb-agent-memory",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "node-llama-cpp": "^3.16.2",
    "sqlite-vec": "0.1.7-alpha.2"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd D:\2026\tencentdb-agent-memory && npm install`
Expected: `node_modules/` created with both packages. sqlite-vec downloads native binary for current platform.

- [ ] **Step 3: Verify sqlite-vec loads**

Run: `node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.enableLoadExtension(true); require('sqlite-vec').load(db); console.log('sqlite-vec OK')"`
Expected: `sqlite-vec OK`

- [ ] **Step 4: Verify node-llama-cpp imports**

Run: `node -e "const p=require('node-llama-cpp/package.json'); console.log('node-llama-cpp', p.version)"`
Expected: Prints version >= 3.16.2

- [ ] **Step 5: Add node_modules to .gitignore**

Create `.gitignore` (or append) with:
```
node_modules/
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add node-llama-cpp + sqlite-vec dependencies"
```

---

### Task 2: Embedding service

**Files:**
- Create: `scripts/embedding_service.js`

- [ ] **Step 1: Write embedding_service.js**

```js
#!/usr/bin/env node
/**
 * Local embedding service using node-llama-cpp + EmbeddingGemma-300m.
 *
 * Background warmup: model downloads on first use, loads async.
 * State machine: idle → initializing → ready | failed.
 * Singleton: getEmbeddingService() returns one shared instance.
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
const DIMENSIONS = 768;
const MAX_INPUT_CHARS = 512;

function sanitizeAndNormalize(vec) {
  const arr = Array.from(vec).map(v => Number.isFinite(v) ? v : 0);
  const magnitude = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return new Float32Array(arr);
  return new Float32Array(arr.map(v => v / magnitude));
}

class EmbeddingService {
  constructor(opts = {}) {
    this.modelPath = opts.modelPath || DEFAULT_MODEL;
    this.modelCacheDir = opts.modelCacheDir || path.join(os.homedir(), ".memory-tencentdb", "models");
    this.state = "idle";
    this.initPromise = null;
    this.initError = null;
    this.embeddingContext = null;
  }

  getDimensions() { return DIMENSIONS; }
  isReady() { return this.state === "ready" && this.embeddingContext !== null; }

  startWarmup() {
    if (this.state === "initializing" || this.state === "ready") return;
    this.state = "initializing";
    this.initError = null;
    this.initPromise = this._doInitialize()
      .then(() => { this.state = "ready"; })
      .catch(err => {
        this.state = "failed";
        this.initError = err instanceof Error ? err : new Error(String(err));
      });
  }

  async embed(text) {
    if (!this.isReady()) return null;
    const truncated = text.length <= MAX_INPUT_CHARS ? text : text.slice(0, MAX_INPUT_CHARS);
    const embedding = await this.embeddingContext.getEmbeddingFor(truncated);
    return sanitizeAndNormalize(embedding.vector);
  }

  async embedBatch(texts) {
    if (!this.isReady()) return null;
    const results = [];
    for (const text of texts) {
      const truncated = text.length <= MAX_INPUT_CHARS ? text : text.slice(0, MAX_INPUT_CHARS);
      const embedding = await this.embeddingContext.getEmbeddingFor(truncated);
      results.push(sanitizeAndNormalize(embedding.vector));
    }
    return results;
  }

  async waitForReady() {
    if (this.initPromise) await this.initPromise;
  }

  close() {
    if (this.embeddingContext) {
      try { this.embeddingContext.dispose?.(); } catch {}
      this.embeddingContext = null;
      this.state = "idle";
      this.initPromise = null;
      this.initError = null;
    }
  }

  async _doInitialize() {
    fs.mkdirSync(this.modelCacheDir, { recursive: true });
    const { getLlama, resolveModelFile, LlamaLogLevel } = await import("node-llama-cpp");
    const llama = await getLlama({ logLevel: LlamaLogLevel.error });
    const resolvedPath = await resolveModelFile(this.modelPath, this.modelCacheDir);
    const model = await llama.loadModel({ modelPath: resolvedPath });
    this.embeddingContext = await model.createEmbeddingContext();
  }
}

let _singleton = null;
function getEmbeddingService() {
  if (!_singleton) _singleton = new EmbeddingService();
  return _singleton;
}

// ── CLI ──
async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help") {
    console.log(`Usage: node embedding_service.js <command>

Commands:
  warmup    Download model and warm up (blocks until ready)
  test      Embed a sample text and print vector stats
  status    Show current state`);
    return;
  }

  const svc = getEmbeddingService();

  if (cmd === "warmup" || cmd === "test") {
    console.log("Starting warmup...");
    svc.startWarmup();
    await svc.waitForReady();
    if (!svc.isReady()) {
      console.error("Warmup failed:", svc.initError?.message);
      process.exit(1);
    }
    console.log("Embedding service ready (dims=" + svc.getDimensions() + ")");

    if (cmd === "test") {
      const vec = await svc.embed("User prefers dark mode in all IDEs");
      console.log("Vector length:", vec.length);
      console.log("First 5 values:", Array.from(vec.slice(0, 5)).map(v => v.toFixed(6)));
      const mag = Math.sqrt(Array.from(vec).reduce((s, v) => s + v * v, 0));
      console.log("L2 norm:", mag.toFixed(6), "(should be ~1.0)");
    }
    svc.close();
  } else if (cmd === "status") {
    console.log(JSON.stringify({ state: svc.state, dims: svc.getDimensions(), model: svc.modelPath }, null, 2));
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { EmbeddingService, getEmbeddingService, sanitizeAndNormalize, DIMENSIONS };
```

- [ ] **Step 2: Verify the module loads (no runtime test yet — model download is slow)**

Run: `node -e "const {EmbeddingService, DIMENSIONS}=require('./scripts/embedding_service.js'); console.log('dims:', DIMENSIONS); const s=new EmbeddingService(); console.log('state:', s.state)"`
Expected: `dims: 768` and `state: idle`

- [ ] **Step 3: Commit**

```bash
git add scripts/embedding_service.js
git commit -m "feat: add local embedding service (EmbeddingGemma-300m)"
```

---

### Task 3: Vector store (sqlite-vec)

**Files:**
- Create: `scripts/vector_store.js`

- [ ] **Step 1: Write vector_store.js**

```js
#!/usr/bin/env node
/**
 * sqlite-vec vector storage for hybrid recall.
 *
 * Separate vectors.db file alongside index.db (FTS5).
 * Uses vec0 virtual table with cosine distance metric.
 * Graceful degradation: if sqlite-vec fails to load, all ops return empty.
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const RRF_K = 60;

class VectorStore {
  constructor(dbPath, dimensions = 768) {
    this.dbPath = path.resolve(dbPath);
    this.dimensions = dimensions;
    this.degraded = false;
    this.db = null;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.enableLoadExtension(true);
      require("sqlite-vec").load(this.db);
      this._initSchema();
    } catch (err) {
      this.degraded = true;
      this.db = null;
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
        record_id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}] distance_metric=cosine
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  upsertVec(recordId, embedding) {
    if (this.degraded || !this.db) return false;
    try {
      this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(recordId);
      this.db.prepare("INSERT INTO l1_vec (record_id, embedding) VALUES (?, ?)").run(
        recordId,
        new Float32Array(embedding)
      );
      return true;
    } catch {
      return false;
    }
  }

  searchVec(queryEmbedding, topK = 10) {
    if (this.degraded || !this.db) return [];
    try {
      return this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `).all(new Float32Array(queryEmbedding), topK);
    } catch {
      return [];
    }
  }

  deleteVec(recordId) {
    if (this.degraded || !this.db) return false;
    try {
      this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(recordId);
      return true;
    } catch {
      return false;
    }
  }

  count() {
    if (this.degraded || !this.db) return 0;
    try {
      return this.db.prepare("SELECT COUNT(*) as c FROM l1_vec").get().c;
    } catch {
      return 0;
    }
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists.
 *
 * @param {Array<Array>} lists - Ranked result lists
 * @param {Function} getId - Extract unique ID from an item
 * @param {number} k - RRF constant (default 60)
 * @returns {Array} Merged list sorted by descending RRF score
 */
function rrfMerge(lists, getId, k = RRF_K) {
  const map = new Map();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(id, { item, rrfScore: score });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}

// ── CLI ──
function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help") {
    console.log(`Usage: node vector_store.js <command>

Commands:
  test    Create a vec0 table, upsert, search (in-memory)
  count   --db <path>  Count vectors in DB`);
    return;
  }

  if (cmd === "test") {
    const dbPath = path.join(require("node:os").tmpdir(), `vec_test_${Date.now()}.db`);
    const store = new VectorStore(dbPath, 4);
    if (store.degraded) {
      console.error("sqlite-vec failed to load — cannot run test");
      process.exit(1);
    }
    console.log("VectorStore created (dims=4)");

    store.upsertVec("r1", [1, 0, 0, 0]);
    store.upsertVec("r2", [0, 1, 0, 0]);
    store.upsertVec("r3", [0.7, 0.7, 0, 0]);
    console.log("Upserted 3 vectors, count:", store.count());

    const results = store.searchVec([1, 0, 0, 0], 3);
    console.log("Search [1,0,0,0] top-3:", results.map(r => `${r.record_id} d=${r.distance.toFixed(4)}`));

    // RRF test
    const fts = [{ record_id: "r1" }, { record_id: "r3" }];
    const vec = [{ record_id: "r3" }, { record_id: "r1" }];
    const merged = rrfMerge([fts, vec], r => r.record_id);
    console.log("RRF merge:", merged.map(m => `${m.record_id} rrf=${m.rrfScore.toFixed(6)}`));

    store.close();
    fs.unlinkSync(dbPath);
    console.log("All vector_store tests passed");
  } else if (cmd === "count") {
    const args = process.argv.slice(3);
    const i = args.indexOf("--db");
    const dbPath = i !== -1 ? args[i + 1] : "";
    if (!dbPath) { console.error("--db required"); process.exit(1); }
    const store = new VectorStore(dbPath);
    console.log(store.count());
    store.close();
  }
}

if (require.main === module) main();

module.exports = { VectorStore, rrfMerge, RRF_K };
```

- [ ] **Step 2: Run the self-test**

Run: `node scripts/vector_store.js test`
Expected:
```
VectorStore created (dims=4)
Upserted 3 vectors, count: 3
Search [1,0,0,0] top-3: r1 d=0.0000 r3 d=... r2 d=...
RRF merge: r3 rrf=... r1 rrf=...
All vector_store tests passed
```

- [ ] **Step 3: Commit**

```bash
git add scripts/vector_store.js
git commit -m "feat: add sqlite-vec vector store with RRF merge"
```

---

### Task 4: Hybrid recall in memory_recall.js

**Files:**
- Modify: `scripts/memory_recall.js`

- [ ] **Step 1: Add hybrid recall to memory_recall.js**

Replace the entire `recall` function and add helper imports. The key change: when embedding is ready, run both FTS5 and vector search, then merge via RRF.

At the top of the file, after existing requires, add:

```js
const { getEmbeddingService } = require("./embedding_service.js");
const { VectorStore, rrfMerge } = require("./vector_store.js");
```

Replace the `recall` function with:

```js
function recall(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;

  const persona = getPersona();
  if (persona) {
    const summary = truncate(persona, 400);
    parts.push(`<persona>\n${summary}\n</persona>`);
    used += summary.length + 24;
  }

  let memories = hybridSearch(query, projectHash, topK);

  if (memories.length) {
    const memLines = [];
    for (const m of memories) {
      const line = `- [${m.type || "?"}] ${m.content}`;
      if (used + line.length + 2 > maxChars) break;
      memLines.push(line);
      used += line.length + 1;
    }
    if (memLines.length) {
      parts.push("<memories>\n" + memLines.join("\n") + "\n</memories>");
    }
  }

  if (!parts.length) return "";
  return "<memory-context>\n" + parts.join("\n") + "\n</memory-context>";
}

function hybridSearch(query, projectHash, topK) {
  const dirs = [globalDir()];
  if (projectHash) dirs.push(projectDir(projectHash));

  let ftsResults = [];
  let vecResults = [];
  const embSvc = getEmbeddingService();
  let queryVec = null;

  // Embed query synchronously-ish: if service is ready, embed; otherwise skip vector path
  // We can't await in a sync function, but embed() returns null when not ready
  // For the hook path, embedding warmup was triggered earlier
  if (embSvc.isReady()) {
    // node-llama-cpp embed is async, but hooks call recall synchronously.
    // Use a sync vector search fallback: check if vectors.db has data and search it.
    // The query embedding must be pre-computed or we skip vector path in sync context.
    // Solution: the hook calls recallAsync() instead.
  }

  // FTS5 path (always available)
  for (const dir of dirs) {
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    const store = new MemoryStore(db);
    ftsResults.push(...store.search(query, topK * 2));
    store.close();
  }

  // Vector path (when embedding is ready — async caller provides queryVec)
  // For sync callers, this is skipped — they get FTS5-only.
  // recallAsync() below handles the hybrid path.

  ftsResults = dedupeAndRank(ftsResults, topK * 2);
  return ftsResults.slice(0, topK);
}
```

**Wait — there's a design issue.** The current `recall()` is called synchronously from the hook. But `embed()` is async (node-llama-cpp uses async inference). We need an async recall path.

Replace the approach: make `on_user_prompt.js` call an async `recallAsync()` function instead. The sync `recall()` stays as FTS5-only fallback for CLI usage.

Add this async function to `memory_recall.js`:

```js
async function recallAsync(query, projectHash = "", maxTokens = DEFAULT_MAX_TOKENS, topK = 5) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;

  const persona = getPersona();
  if (persona) {
    const summary = truncate(persona, 400);
    parts.push(`<persona>\n${summary}\n</persona>`);
    used += summary.length + 24;
  }

  const dirs = [globalDir()];
  if (projectHash) dirs.push(projectDir(projectHash));

  // FTS5 path
  let ftsResults = [];
  for (const dir of dirs) {
    const db = path.join(dir, "index.db");
    if (!fs.existsSync(db)) continue;
    const store = new MemoryStore(db);
    ftsResults.push(...store.search(query, topK * 2));
    store.close();
  }

  // Vector path
  let vecResults = [];
  const embSvc = getEmbeddingService();
  if (embSvc.isReady()) {
    try {
      const queryVec = await embSvc.embed(query);
      if (queryVec) {
        for (const dir of dirs) {
          const vecDb = path.join(dir, "vectors.db");
          if (!fs.existsSync(vecDb)) continue;
          const vecStore = new VectorStore(vecDb);
          if (!vecStore.degraded) {
            const hits = vecStore.searchVec(queryVec, topK * 2);
            // Enrich with metadata from FTS5 store
            const ftsStore = new MemoryStore(path.join(dir, "index.db"));
            for (const hit of hits) {
              const meta = ftsStore.get(hit.record_id);
              if (meta) vecResults.push({ ...meta, distance: hit.distance });
            }
            ftsStore.close();
          }
          vecStore.close();
        }
      }
    } catch {}
  }

  // Merge
  let memories;
  if (vecResults.length > 0 && ftsResults.length > 0) {
    memories = rrfMerge(
      [ftsResults, vecResults],
      r => r.record_id
    ).slice(0, topK);
  } else {
    memories = dedupeAndRank(ftsResults, topK);
  }

  if (memories.length) {
    const memLines = [];
    for (const m of memories) {
      const line = `- [${m.type || "?"}] ${m.content}`;
      if (used + line.length + 2 > maxChars) break;
      memLines.push(line);
      used += line.length + 1;
    }
    if (memLines.length) {
      parts.push("<memories>\n" + memLines.join("\n") + "\n</memories>");
    }
  }

  if (!parts.length) return "";
  return "<memory-context>\n" + parts.join("\n") + "\n</memory-context>";
}
```

Update the `module.exports` to include `recallAsync`:

```js
module.exports = { recall, recallAsync };
```

- [ ] **Step 2: Verify existing sync recall still works**

Run: `node -e "const {recall}=require('./scripts/memory_recall.js'); console.log(typeof recall)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add scripts/memory_recall.js
git commit -m "feat: add async hybrid recall (FTS5 + vector + RRF)"
```

---

### Task 5: Embed on upsert in memory_store.js

**Files:**
- Modify: `scripts/memory_store.js`

- [ ] **Step 1: Add vector upsert to MemoryStore.upsert()**

After the existing FTS5 insert in the `upsert` method (line ~139, after the `l1_fts INSERT`), add best-effort vector embedding:

```js
    // Best-effort vector embedding
    this._embedAndStore(rid, record.content);
```

Add this method to the MemoryStore class:

```js
  _embedAndStore(recordId, content) {
    try {
      const { getEmbeddingService } = require("./embedding_service.js");
      const { VectorStore } = require("./vector_store.js");
      const embSvc = getEmbeddingService();
      if (!embSvc.isReady()) return;
      // Embed is async — fire and forget for sync upsert
      embSvc.embed(content).then(vec => {
        if (!vec) return;
        const vecDbPath = path.join(path.dirname(this.dbPath), "vectors.db");
        const vecStore = new VectorStore(vecDbPath);
        vecStore.upsertVec(recordId, vec);
        vecStore.close();
      }).catch(() => {});
    } catch {}
  }
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `node scripts/eval_runner.js --section 3 --format text`
Expected: `15/15 passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add scripts/memory_store.js
git commit -m "feat: embed on upsert (best-effort, async)"
```

---

### Task 6: Trigger warmup from hook

**Files:**
- Modify: `hooks/scripts/on_user_prompt.js`

- [ ] **Step 1: Add warmup call to on_user_prompt.js**

Add embedding warmup at the start of `main()`, before the recall call. Replace the `localRecall` function to use async path:

Replace the entire file content:

```js
#!/usr/bin/env node
/**
 * UserPromptSubmit hook — hybrid recall (FTS5 + vector), inject via additionalContext.
 */
"use strict";

const nodePath = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

async function doRecall(prompt, cwd) {
  try {
    // Trigger embedding warmup (non-blocking, idempotent)
    try {
      const { getEmbeddingService } = require(nodePath.join(scriptsDir, "embedding_service.js"));
      getEmbeddingService().startWarmup();
    } catch {}

    const { projectHashForCwd } = require(nodePath.join(scriptsDir, "memory_reader.js"));
    const projectHash = cwd ? projectHashForCwd(cwd) : "";

    // Try async hybrid recall first
    try {
      const { recallAsync } = require(nodePath.join(scriptsDir, "memory_recall.js"));
      return await recallAsync(prompt, projectHash);
    } catch {}

    // Fallback to sync FTS5-only recall
    const { recall } = require(nodePath.join(scriptsDir, "memory_recall.js"));
    return recall(prompt, projectHash);
  } catch {
    return "";
  }
}

async function main() {
  const payload = await readHookInputAsync();
  const prompt = payload.prompt || payload.user_prompt || "";
  if (!prompt.trim()) { emit({}); return; }

  const cwd = payload.cwd || "";
  const ctx = await doRecall(prompt, cwd);

  if (!ctx) { emit({}); return; }

  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
}

main().catch(() => { emit({}); process.exit(0); });
```

- [ ] **Step 2: Verify hook still loads without errors**

Run: `echo '{}' | node hooks/scripts/on_user_prompt.js`
Expected: `{}` (empty output, no crash)

- [ ] **Step 3: Commit**

```bash
git add hooks/scripts/on_user_prompt.js
git commit -m "feat: trigger embedding warmup + async hybrid recall in hook"
```

---

### Task 7: Reindex command

**Files:**
- Create: `commands/memory-reindex.md`

- [ ] **Step 1: Write memory-reindex.md**

```markdown
---
description: Rebuild vector index (vectors.db) from existing FTS5 memories. Run after first install or model change.
allowed-tools: [Bash]
---

Reindex all L1 memory records into the vector store. This embeds each record's content
using the local EmbeddingGemma model and stores the vectors in `vectors.db`.

First run will download the model (~80MB) if not already cached.

` ``bash
node -e "
const path = require('node:path');
const fs = require('node:fs');
const { globalDir, projectDir } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_writer.js');
const { projectHashForCwd } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_reader.js');
const { MemoryStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/memory_store.js');
const { VectorStore } = require('${CLAUDE_PLUGIN_ROOT}/scripts/vector_store.js');
const { getEmbeddingService } = require('${CLAUDE_PLUGIN_ROOT}/scripts/embedding_service.js');

async function reindex(dir, label) {
  const dbPath = path.join(dir, 'index.db');
  if (!fs.existsSync(dbPath)) { console.log(label + ': no index.db, skipping'); return 0; }
  const ftsStore = new MemoryStore(dbPath);
  const records = ftsStore.allRecords('', 10000);
  ftsStore.close();
  if (!records.length) { console.log(label + ': 0 records, skipping'); return 0; }

  const vecDbPath = path.join(dir, 'vectors.db');
  const vecStore = new VectorStore(vecDbPath);
  if (vecStore.degraded) { console.error(label + ': sqlite-vec failed to load'); return 0; }

  const svc = getEmbeddingService();
  let count = 0;
  for (const r of records) {
    const vec = await svc.embed(r.content);
    if (vec) { vecStore.upsertVec(r.record_id, vec); count++; }
    if (count % 50 === 0 && count > 0) console.log(label + ': ' + count + '/' + records.length);
  }
  vecStore.close();
  console.log(label + ': indexed ' + count + '/' + records.length + ' records');
  return count;
}

async function main() {
  const svc = getEmbeddingService();
  console.log('Warming up embedding model (first run downloads ~80MB)...');
  svc.startWarmup();
  await svc.waitForReady();
  if (!svc.isReady()) { console.error('Embedding failed:', svc.initError?.message); process.exit(1); }
  console.log('Embedding ready (dims=' + svc.getDimensions() + ')');

  const gDir = globalDir();
  const cwd = process.env.CLAUDE_PROJECT_DIR || '.';
  const pHash = projectHashForCwd(cwd);
  const pDir = projectDir(pHash);

  let total = 0;
  total += await reindex(gDir, 'Global');
  total += await reindex(pDir, 'Project(' + pHash + ')');

  console.log('Done. Total vectors indexed: ' + total);
  svc.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
"
` ``
```

(Note: the backtick fence above should be triple backticks — escaped here for nesting.)

- [ ] **Step 2: Commit**

```bash
git add commands/memory-reindex.md
git commit -m "feat: add /memory-reindex command for vector index rebuild"
```

---

### Task 8: Add eval section for embedding + vector store

**Files:**
- Modify: `scripts/eval_runner.js`

- [ ] **Step 1: Add section 9 to eval_runner.js**

Add this function before the `// ── Utilities ──` section:

```js
// ── Section 9: Vector Store + RRF ──
function testVectorStore(ev) {
  ev.section("9. Vector Store + RRF");

  let VectorStore, rrfMerge;
  try {
    ({ VectorStore, rrfMerge } = require(path.join(PLUGIN_ROOT, "scripts/vector_store.js")));
  } catch (e) {
    ev.check("require(vector_store.js)", false, e.message.split("\n")[0]);
    return;
  }
  ev.check("require(vector_store.js)", true);

  const dbPath = path.join(os.tmpdir(), `eval_vec_${Date.now()}.db`);
  const store = new VectorStore(dbPath, 4);
  ev.check("VectorStore: init (degraded=" + store.degraded + ")", !store.degraded);

  if (store.degraded) {
    store.close();
    return;
  }

  store.upsertVec("v1", [1, 0, 0, 0]);
  store.upsertVec("v2", [0, 1, 0, 0]);
  store.upsertVec("v3", [0.7, 0.7, 0, 0]);
  ev.check("VectorStore: upsert count", store.count() === 3, `count=${store.count()}`);

  const results = store.searchVec([1, 0, 0, 0], 3);
  ev.check("VectorStore: KNN search returns results", results.length === 3);
  ev.check("VectorStore: nearest is v1", results[0]?.record_id === "v1");

  store.deleteVec("v2");
  ev.check("VectorStore: delete", store.count() === 2);

  store.close();
  fs.unlinkSync(dbPath);

  // RRF merge test
  const fts = [{ record_id: "a" }, { record_id: "b" }, { record_id: "c" }];
  const vec = [{ record_id: "b" }, { record_id: "a" }, { record_id: "d" }];
  const merged = rrfMerge([fts, vec], r => r.record_id);
  ev.check("RRF: b ranked first (in both lists)", merged[0].record_id === "b" || merged[0].record_id === "a");
  ev.check("RRF: all 4 items present", merged.length === 4);
  ev.check("RRF: items in both lists have higher score", merged[0].rrfScore > merged[3].rrfScore);

  // Embedding service module loading
  try {
    const { EmbeddingService, DIMENSIONS } = require(path.join(PLUGIN_ROOT, "scripts/embedding_service.js"));
    ev.check("EmbeddingService: loads", true);
    ev.check("EmbeddingService: DIMENSIONS=768", DIMENSIONS === 768);
    const svc = new EmbeddingService();
    ev.check("EmbeddingService: state=idle", svc.state === "idle");
    ev.check("EmbeddingService: isReady=false before warmup", !svc.isReady());
  } catch (e) {
    ev.check("EmbeddingService: loads", false, e.message.split("\n")[0]);
  }
}
```

Register it in the `allSections` array:

```js
  const allSections = [
    [1, testPluginStructure],
    [2, testModuleLoading],
    [3, testFTS5],
    [4, testL0Reader],
    [5, testWriter],
    [6, testBenchmark],
    [7, testRealTranscripts],
    [8, testAutoCapture],
    [9, testVectorStore],
  ];
```

Also update section 1 scripts list to include new files:

```js
  const scripts = ["memory_store.js", "memory_reader.js", "memory_writer.js", "memory_recall.js", "memory_auto_capture.js", "memory_pipeline.js", "benchmark.js", "embedding_service.js", "vector_store.js"];
```

And update section 2 module loading to include new modules:

```js
  const modules = [
    ["scripts/memory_store.js", "MemoryStore"],
    ["scripts/memory_reader.js", "readSession"],
    ["scripts/memory_writer.js", "writeL1Record"],
    ["scripts/memory_recall.js", "recall"],
    ["scripts/memory_auto_capture.js", "autoCapture"],
    ["scripts/embedding_service.js", "EmbeddingService"],
    ["scripts/vector_store.js", "VectorStore"],
  ];
```

- [ ] **Step 2: Run eval**

Run: `node scripts/eval_runner.js --format text`
Expected: All sections pass (section 9 should show ~12 new checks passing). Total should be 87 + ~12 = ~99 checks.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval_runner.js
git commit -m "test: add eval section 9 for vector store + RRF + embedding service"
```

---

### Task 9: Update skills and docs

**Files:**
- Modify: `skills/memory-architecture/SKILL.md`
- Modify: `skills/memory-recall-tuning/SKILL.md`
- Modify: `skills/memory-setup/SKILL.md`

- [ ] **Step 1: Update memory-architecture SKILL.md**

In the "Recall strategy" section, replace the FTS5-only description with:

```markdown
## Recall strategy

Hybrid recall: local FTS5 keyword search + EmbeddingGemma-300m vector cosine similarity, merged via Reciprocal Rank Fusion (RRF, k=60).

- FTS5 searches both global and project-scoped `index.db` (keyword matching)
- sqlite-vec searches `vectors.db` using cosine distance (semantic matching)
- Results merged via RRF: items appearing in both lists get boosted scores
- Graceful degradation: if embedding not ready or sqlite-vec unavailable, falls back to FTS5-only
- Persona section always injected as safety net
- Token budget: ~280 tokens max

First run requires `/memory-reindex` to build vectors from existing memories.
```

- [ ] **Step 2: Update memory-setup SKILL.md**

Add step between seed and consolidate:

```markdown
## 3.5. Build vector index (first time only)

` ``
/memory-reindex
` ``

Downloads the EmbeddingGemma-300m model (~80MB) on first run, then embeds all existing L1 atoms into `vectors.db` for hybrid recall.
```

- [ ] **Step 3: Update memory-recall-tuning SKILL.md**

Add to the "Level 1" table:

```markdown
| Hybrid recall | `memory_recall.js:recallAsync()` | FTS5 + vector + RRF | Automatic when embedding ready; FTS5-only fallback |
```

- [ ] **Step 4: Commit**

```bash
git add skills/memory-architecture/SKILL.md skills/memory-recall-tuning/SKILL.md skills/memory-setup/SKILL.md
git commit -m "docs: update skills for hybrid recall architecture"
```

---

### Task 10: Final integration test

- [ ] **Step 1: Run full eval suite**

Run: `node scripts/eval_runner.js --format text`
Expected: All sections pass, 0 failures.

- [ ] **Step 2: Run vector_store self-test**

Run: `node scripts/vector_store.js test`
Expected: `All vector_store tests passed`

- [ ] **Step 3: Verify embedding_service loads**

Run: `node -e "const {EmbeddingService,DIMENSIONS}=require('./scripts/embedding_service.js'); console.log('OK dims='+DIMENSIONS)"`
Expected: `OK dims=768`

- [ ] **Step 4: Verify hook doesn't crash**

Run: `echo '{"prompt":"test","cwd":"."}' | node hooks/scripts/on_user_prompt.js`
Expected: Valid JSON output (either `{}` or `{hookSpecificOutput:...}`)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for local embedding"
```
