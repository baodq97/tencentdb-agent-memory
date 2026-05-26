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
