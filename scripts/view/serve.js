#!/usr/bin/env node
/**
 * `tmem view` session server — live, read-only HTTP + SSE over the memory store.
 *
 * Zero dependency by construction — Node built-ins only (http, fs, path, crypto, os).
 * Nothing is vendored, so there is no third-party code to audit or patch.
 *
 * Architecture adapted from the live preview server in a sibling plugin of ours, which
 * in turn adapted the brainstorm companion server in the `superpowers` plugin
 * (https://github.com/obra/superpowers, MIT, Jesse Vincent): a session directory, a
 * session key on every route, SSE push to an already-open browser, and the user's
 * clicks recorded as JSONL for the agent's next turn. All three of those survive here
 * verbatim in spirit. What changed is the thing being served.
 *
 * THE DEPARTURE FROM THAT DESIGN
 * ------------------------------
 * That server serves a FROZEN `model.json` snapshot: the agent rewrites the file, the
 * server watches that one path, the browser re-renders. There is no such file here.
 * This server is a thin HTTP skin over a LIVE read-only backend — a full aggregate
 * pass over all 49 stores measures ~65 ms, so every query runs per-request and there
 * is no payload to precompute and no payload to watch.
 *
 * Three consequences are designed for explicitly:
 *
 *   1. The SSE channel does not mean "the model file changed". It means "the
 *      underlying store changed". The store is written continuously by this
 *      plugin's own Stop hook WHILE the user is reading the page — it grew 30
 *      records during a single conversation. So the watcher polls a cheap
 *      filesystem fingerprint (mtime+size of every index.db / vectors.db /
 *      persona.md, ~150 stats, sub-millisecond), and only when THAT moves does it
 *      pay the 65 ms to recompute the contract's `snapshotId`. An event is emitted
 *      only when the snapshotId genuinely differs.
 *
 *   2. The event is an OFFER, not a re-render. The UI is expected to show a
 *      "store changed — refresh" badge. A number silently changing under the
 *      user's eyes while they are reading it is worse than a stale number that
 *      says it is stale. This server never pushes data, only the fact that data
 *      moved; every envelope carries the `snapshotId` it was computed against so a
 *      client can tell that page 2 came from a different state than page 1.
 *
 *   3. `--snapshot` / `--static` pins one snapshotId for the entire session. The
 *      watcher is disabled and every route answers from the same pinned extract,
 *      so a before/after measurement is apples-to-apples.
 *
 * PRIVACY
 * -------
 * This renders the user's raw auto-captured prompts from every repo they have ever
 * opened — 38.6% of which is structural noise, and some of which contains internal
 * paths and work content. Localhost plus the session key is the entire boundary, so
 * both are non-negotiable: the key gates the shell as well as `/api/*`, and a bare
 * `host:port` is refused. There is deliberately NO route that writes to the memory
 * store, and no export-to-file route beyond what `--snapshot` already covers.
 *
 * DATA ACCESS
 * -----------
 * All extraction and all metrics come from `extract.js` + `transform.js` through the
 * adapter in the PIPELINE section below. This module computes no metric of its own —
 * a second implementation of "how many records lack a vector" is exactly the drift
 * the ETL split exists to prevent. Where transform does not expose something this
 * server needs, the route fails loudly with the missing export named, rather than
 * quietly substituting a plausible number.
 *
 * `/api/recall` is the one route that bypasses the pipeline: it calls the real
 * `recallAsync()` from `scripts/memory_recall.js`, so the Context lens shows the
 * literal block that would be injected rather than a reimplementation of ranking.
 *
 * Usage:
 *   node scripts/view/serve.js [--port N] [--host H] [--url-host H] [--root DIR]
 *                              [--session-dir DIR] [--idle-timeout-minutes N]
 *                              [--snapshot | --static] [--open]
 *
 * Session directory layout (defaults to ~/.memory-tencentdb/view/, never inside a repo):
 *   <session-dir>/events.jsonl        <- the user's browser interactions, one JSON per line
 *   <session-dir>/server-info.json    <- connection details, for when stdout is not captured
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const C = require("./contract.js");
const { memoryBaseDir } = require("../memory_writer.js");

/* ------------------------------------------------------------------ *
 * args
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/**
 * The memory store root. Read-only for the entire lifetime of this process.
 *
 * The default comes from `memory_writer.memoryBaseDir()` rather than being spelled
 * out again here. A third copy of `path.join(os.homedir(), ".memory-tencentdb")`
 * would be the one that fails SILENTLY when the layout moves: extract.js restates
 * the layout too, but guards it with a require-time assertion, so a change there
 * throws while a change here would just quietly serve an empty store.
 */
const ROOT_DIR = path.resolve(
  args.root || process.env.TMEM_VIEW_ROOT || memoryBaseDir(),
);

/**
 * Session scratch. Defaults under the store root rather than the cwd on purpose:
 * a repo must never acquire an untracked `.tmem-view/` because the user ran the
 * visualiser while standing in it. `view/` is the ONLY path this process writes.
 */
const SESSION_DIR = path.resolve(
  args["session-dir"] || process.env.TMEM_VIEW_SESSION_DIR || path.join(ROOT_DIR, "view"),
);

const HOST = args.host || process.env.TMEM_VIEW_HOST || "127.0.0.1";
const URL_HOST =
  args["url-host"] || (HOST === "127.0.0.1" || HOST === "0.0.0.0" ? "localhost" : HOST);
const PORT = Number(args.port || process.env.TMEM_VIEW_PORT || 0); // 0 => OS picks a free port
const IDLE_MINUTES = Number(args["idle-timeout-minutes"] || process.env.TMEM_VIEW_IDLE_MINUTES || 240);

/** Pinned mode: one snapshotId for the whole session, watcher off. */
const PINNED = Boolean(args.snapshot || args.static);

/** How often the cheap fs fingerprint is re-stat'ed. Not the 65 ms pass. */
const WATCH_INTERVAL_MS = Number(args["watch-interval-ms"] || 3000);

const EVENTS_PATH = path.join(SESSION_DIR, "events.jsonl");
const INFO_PATH = path.join(SESSION_DIR, "server-info.json");
const SHELL_PATH = path.join(__dirname, "shell.html");

const KEY = crypto.randomBytes(16).toString("hex");
const COOKIE_NAME = "tmem_view_key";

/* ------------------------------------------------------------------ *
 * PIPELINE — the adapter over extract.js + transform.js
 *
 * Those two modules are being written in parallel with this one, so this server
 * codes against the CONTRACT (contract.js §3, §4, §8), not against their files.
 * The adapter resolves each capability by trying the plausible export names in
 * order, and — critically — fails LOUDLY and by name when it cannot. A route that
 * cannot reach transform returns a 500 envelope saying which export it looked for;
 * it never falls back to computing the number here, because a serve-side
 * reimplementation of a metric is the exact drift the ETL split prevents.
 *
 * Expected shapes (contract.js):
 *   extract:        (rootDir) -> RootExtract                    (§3)
 *   transform:      (RootExtract) -> Snapshot                   (§4, §8)
 *   rows:           (StoreExtract, Snapshot?) -> RecordRow[]    (§8 RecordsPage)
 *   listStores:     (rootDir) -> StoreRef[]                     (§3; existsSync-only)
 *   probeSqliteVec: () -> {module, from, reason}                (opens no database)
 *
 * The last two are not metric producers — they are the two capability questions
 * this server has to ask directly ("which stores exist", "can vectors be read at
 * all"). They live here rather than being answered locally because both answers
 * have a single correct implementation in extract, and BOTH of the local versions
 * this replaced were wrong: one enumerated `projects/*` without an isDirectory()
 * filter, the other probed sqlite-vec by constructing a `VectorStore`, which
 * writes. See vectorCapability() for what that cost.
 * ------------------------------------------------------------------ */

const PIPELINE_API = Object.freeze({
  extract: ["extractRoot", "extract", "extractAll", "readRoot", "collect"],
  transform: ["transformRoot", "transform", "buildSnapshot", "toSnapshot", "summarise", "summarize"],
  rows: ["buildRecordRows", "recordRows", "toRecordRows", "buildRows", "rowsForStore"],
  listStores: ["listStores", "discoverStores", "storeRefs"],
  probe: ["probeSqliteVec", "probeVectorExtension"],
});

/**
 * Where extract.js / transform.js live. Overridable so a test can inject a
 * fixture pipeline without a fixture HTTP server; production always resolves to
 * this directory.
 */
const PIPELINE_DIR = path.resolve(
  args["pipeline-dir"] || process.env.TMEM_VIEW_PIPELINE_DIR || __dirname,
);

function loadModule(file) {
  try {
    // eslint-disable-next-line global-require
    return { mod: require(path.join(PIPELINE_DIR, file)), error: null };
  } catch (err) {
    return { mod: null, error: err };
  }
}

function pick(mod, names) {
  if (!mod) return null;
  for (const n of names) if (typeof mod[n] === "function") return mod[n];
  return null;
}

let _pipeline = null;

/** Resolved lazily so the server can start (and explain itself) without the ETL modules. */
function pipeline() {
  if (_pipeline) return _pipeline;
  const ex = loadModule("extract.js");
  const tr = loadModule("transform.js");
  _pipeline = {
    extractMod: ex.mod,
    transformMod: tr.mod,
    extractErr: ex.error,
    transformErr: tr.error,
    extract: pick(ex.mod, PIPELINE_API.extract),
    transform: pick(tr.mod, PIPELINE_API.transform),
    rows: pick(tr.mod, PIPELINE_API.rows),
    listStores: pick(ex.mod, PIPELINE_API.listStores),
    probeSqliteVec: pick(ex.mod, PIPELINE_API.probe),
  };
  return _pipeline;
}

function missingPipelineMessage(which) {
  const p = pipeline();
  const fromExtract = which === "extract" || which === "listStores" || which === "probe";
  const file = path.join(PIPELINE_DIR, fromExtract ? "extract.js" : "transform.js");
  const err = fromExtract ? p.extractErr : p.transformErr;
  const looked = PIPELINE_API[which].join(", ");
  if (err) {
    return `${file} could not be loaded (${err.code || "error"}: ${err.message}). ` +
      `serve.js does not reimplement extraction or metrics — see contract.js §3/§4.`;
  }
  return `${file} loaded but exports none of [${looked}]. ` +
    `serve.js needs one of those; it deliberately does not compute this itself.`;
}

/* ------------------------------------------------------------------ *
 * cheap fingerprint — the drift detector
 *
 * O(stores) fs.stat calls, no reads. Its only job is to decide whether the 65 ms
 * aggregate pass is worth paying. It is NOT the snapshotId: the snapshotId is the
 * contract's (§7) and is computed by transform from real counts. Two different
 * fingerprints can produce the same snapshotId (a WAL checkpoint that changed no
 * rows), and that is fine — the fingerprint over-triggers, the snapshotId decides.
 * ------------------------------------------------------------------ */

function statPart(p) {
  try {
    const st = fs.statSync(p);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return "-";
  }
}

/**
 * The root extract actually read, echoed back from `RootExtract.rootDir` rather
 * than assumed. `--root` is passed to `extractAll({rootDir})` and honoured, but
 * extract still owns resolution (it resolves the path and defaults to
 * memory_writer.memoryBaseDir()), so the watcher follows what was read instead of
 * polling a directory nobody opened.
 */
let effectiveRootDir = ROOT_DIR;

/**
 * Store discovery for the fingerprint, delegated to `extract.listStores()`.
 *
 * It was re-derived here once, with a bare `readdirSync` and no `isDirectory()`
 * filter, so a stray file dropped into `projects/` entered the fingerprint as if
 * it were a store. Beyond the wrong answer, that was a second definition of
 * "where a store lives" — and `StoreRef` already carries exactly the paths this
 * function stats (`indexDbPath`, `vectorDbPath`, `sceneDir`), so it can be read
 * instead of guessed. Discovery is `existsSync`-only in extract, opening no
 * database, which keeps this cheap enough to run every tick.
 *
 * @returns {import('./contract.js').StoreRef[]}
 */
function storeRefs() {
  const p = pipeline();
  if (!p.listStores) return [];
  try {
    return p.listStores(effectiveRootDir);
  } catch {
    return [];
  }
}

function fsFingerprint() {
  const parts = [];
  for (const f of ["state.json", "config.json", "capture_state.json"]) {
    parts.push(`${f}=${statPart(path.join(effectiveRootDir, f))}`);
  }
  const refs = [...storeRefs()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const ref of refs) {
    parts.push(
      `${ref.slug}|${statPart(ref.indexDbPath)}` +
      `|${statPart(`${ref.indexDbPath}-wal`)}` +
      // `vectorDbPath` is null when absent, and a store ACQUIRING a vectors.db is
      // itself a state change, so stat the conventional path rather than the
      // nullable one — "-" and a size are different fingerprints.
      `|${statPart(path.join(ref.dir, "vectors.db"))}` +
      `|${statPart(path.join(ref.dir, "persona.md"))}` +
      `|${statPart(ref.sceneDir)}`,
    );
  }
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * snapshot cache
 *
 * Keyed by the fs fingerprint, so a burst of requests against an unchanged store
 * pays 65 ms once, and the first request after a store write pays it again. In
 * PINNED mode the first computation is kept forever.
 * ------------------------------------------------------------------ */

/** @type {{fingerprint: string, root: any, snapshot: any, builtAt: number, ms: number}|null} */
let cache = null;

/**
 * @param {boolean} [force]
 * @returns {{root: any, snapshot: any, ms: number, cached: boolean}}
 * @throws {Error} with `.pipelineStage` when extract/transform are unreachable.
 */
function currentSnapshot(force = false) {
  if (cache && PINNED) return { ...cache, cached: true };
  const fp = PINNED ? "pinned" : fsFingerprint();
  if (!force && cache && cache.fingerprint === fp) return { ...cache, cached: true };

  const p = pipeline();
  if (!p.extract) {
    const e = new Error(missingPipelineMessage("extract"));
    e.pipelineStage = "extract";
    throw e;
  }
  if (!p.transform) {
    const e = new Error(missingPipelineMessage("transform"));
    e.pipelineStage = "transform";
    throw e;
  }

  const t0 = process.hrtime.bigint();
  const root = p.extract({ rootDir: ROOT_DIR });
  const t1 = process.hrtime.bigint();
  const extractMs = Number(t1 - t0) / 1e6;
  // extractMs is handed to transform rather than measured twice, so
  // `Snapshot.timing` reports what this process actually spent instead of
  // transform's guess at it.
  const snapshot = p.transform(root, { extractMs });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // Echoed back from the extract, not assumed: extract owns root resolution.
  if (root && root.rootDir) effectiveRootDir = root.rootDir;

  cache = { fingerprint: fp, root, snapshot, builtAt: Date.now(), ms };
  return { ...cache, cached: false };
}

function envelopeMeta(snapshot) {
  return {
    snapshotId: snapshot && snapshot.snapshotId ? snapshot.snapshotId : null,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * auth
 *
 * The key gates EVERY route, the shell included. A bare host:port is refused —
 * this page renders the user's prompt history from every repo they have opened,
 * so "it's only on localhost" is not, on its own, the boundary. After the first
 * load the browser carries the key in a cookie, so reloads and fetches work
 * without threading the query string through every URL.
 * ------------------------------------------------------------------ */

function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function authorized(req, url) {
  const q = url.searchParams.get("key");
  if (q && timingSafeEqual(q, KEY)) return true;
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${COOKIE_NAME}=`) && timingSafeEqual(t.slice(COOKIE_NAME.length + 1), KEY)) {
      return true;
    }
  }
  return false;
}

function deny(res, isApi) {
  if (isApi) {
    res.writeHead(403, JSON_HEADERS);
    res.end(JSON.stringify(C.apiError(C.API_ERROR.BAD_REQUEST, "missing or bad session key")));
    return;
  }
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(
    "403 — missing or bad session key.\n\n" +
    "Use the full URL printed at startup, including ?key=…\n" +
    "It is also in server-info.json in the session directory.\n",
  );
}

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // This page renders private prompt history; keep it out of any cache or referer.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/* ------------------------------------------------------------------ *
 * SSE fan-out
 * ------------------------------------------------------------------ */

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    // A disconnected client can throw on write; drop it rather than crash the server.
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/* ------------------------------------------------------------------ *
 * watcher
 *
 * fs.watch is not used: the store is 49 directories deep in the user's home and a
 * recursive watch on it is both platform-dependent and far more expensive than
 * the ~150 stats below. Polling is the cheap option here, not the lazy one.
 * ------------------------------------------------------------------ */

let lastKnownSnapshotId = null;
let lastFingerprint = null;

function checkForDrift() {
  let fp;
  try {
    fp = fsFingerprint();
  } catch {
    return;
  }
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;

  let snapshot;
  try {
    ({ snapshot } = currentSnapshot());
  } catch (err) {
    // The pipeline being unavailable is a startup-shaped problem, not a per-tick
    // one; say it once per transition rather than every 3 seconds.
    broadcast("error", { at: Date.now(), message: err.message });
    return;
  }
  const id = snapshot && snapshot.snapshotId;
  if (!id || id === lastKnownSnapshotId) return; // fingerprint moved, state did not
  const previous = lastKnownSnapshotId;
  lastKnownSnapshotId = id;

  // The contract's payload for this event. Note what is NOT here: any data. The
  // client is being told the state moved so it can OFFER a refresh; it is not
  // being re-rendered underneath the person reading it.
  broadcast("snapshot", {
    type: "snapshot",
    snapshotId: id,
    previousSnapshotId: previous,
    at: Date.now(),
  });
}

function startWatcher() {
  if (PINNED) return null;
  const t = setInterval(checkForDrift, WATCH_INTERVAL_MS);
  t.unref();
  return t;
}

/* ------------------------------------------------------------------ *
 * idle shutdown
 * ------------------------------------------------------------------ */

let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };

function startIdleTimer() {
  if (IDLE_MINUTES <= 0) return null;
  const t = setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActivity > IDLE_MINUTES * 60_000) {
      process.stderr.write(`tmem-view: idle for ${IDLE_MINUTES}m, exiting\n`);
      process.exit(0);
    }
  }, 60_000);
  t.unref();
  return t;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

/** GET /api/snapshot */
function routeSnapshot(res, setCookie) {
  const { snapshot, ms, cached } = currentSnapshot();
  lastKnownSnapshotId = snapshot.snapshotId || lastKnownSnapshotId;
  sendJson(
    res,
    200,
    C.apiOk(snapshot, envelopeMeta(snapshot)),
    { ...setCookie, "server-timing": `pipeline;dur=${ms.toFixed(1)}`, "x-tmem-cached": String(cached) },
  );
}

/** GET /api/store/:slug/records */
function routeStoreRecords(res, url, slug, setCookie) {
  const { root, snapshot } = currentSnapshot();
  const meta = envelopeMeta(snapshot);

  const storeExtract = (root.stores || []).find((s) => s.ref && s.ref.slug === slug);
  if (!storeExtract) {
    sendJson(res, 404, C.apiError(C.API_ERROR.NOT_FOUND, `no store with slug ${JSON.stringify(slug)}`, meta), setCookie);
    return;
  }
  if (storeExtract.records && storeExtract.records.status === C.STATUS.ERROR) {
    sendJson(
      res, 200,
      C.apiError(C.API_ERROR.STORE_UNREADABLE, storeExtract.records.reason || "index.db unreadable", meta),
      setCookie,
    );
    return;
  }

  const build = pipeline().rows;
  if (!build) {
    // Loud, by name. The alternative — classifying low-signal and duplicates here —
    // would put a second implementation of the headline metric in the HTTP layer.
    sendJson(
      res, 500,
      C.apiError(C.API_ERROR.INTERNAL, missingPipelineMessage("rows"), meta),
      setCookie,
    );
    return;
  }

  /** @type {import('./contract.js')} rows are contract RecordRow[] */
  const allRows = build(storeExtract, snapshot) || [];
  // The row count in the TABLE, not the length of the (possibly capped) slice
  // extract handed over — contract.js RecordsPage.storeTotal is "rows in the
  // store, unfiltered". Reporting the slice length would quietly under-report a
  // store that hit extract's per-store record cap.
  const storeTotal = typeof storeExtract.records.total === "number"
    ? storeExtract.records.total
    : allRows.length;

  const filter = {
    type: url.searchParams.get("type") || null,
    writePath: url.searchParams.get("writePath") || null,
    q: url.searchParams.get("q") || null,
    hasVector: url.searchParams.has("hasVector") ? url.searchParams.get("hasVector") : null,
    lowSignal: url.searchParams.get("lowSignal") || null,
  };

  let rows = allRows;
  if (filter.type) rows = rows.filter((r) => r.type === filter.type);
  if (filter.writePath) rows = rows.filter((r) => r.writePath === filter.writePath);
  if (filter.lowSignal) rows = rows.filter((r) => Array.isArray(r.lowSignal) && r.lowSignal.includes(filter.lowSignal));
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    rows = rows.filter((r) => String(r.content || "").toLowerCase().includes(needle));
  }
  if (filter.hasVector !== null) {
    // `hasVector` is null (not false) on rows whose store could not be measured;
    // filtering on true/false must therefore EXCLUDE nulls rather than treat them
    // as "no vector". That conflation is the original false alarm, in miniature.
    const want = filter.hasVector === "true" || filter.hasVector === "1";
    rows = rows.filter((r) => r.hasVector === want);
  }

  const total = rows.length;
  const limit = clampInt(url.searchParams.get("limit"), C.PAGE.DEFAULT_LIMIT, 1, C.PAGE.MAX_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const vectors = storeExtract.vectors || C.unmeasured("vectors not read");

  /** @type {import('./contract.js').RecordsPage} */
  const page = {
    slug,
    rows: rows.slice(offset, offset + limit),
    offset,
    limit,
    total,
    storeTotal,
    filter,
    vectorStatus: vectors.status,
    vectorReason: vectors.reason || null,
    // Not in the contract's RecordsPage, but extract caps rows per store: a UI
    // that pages to the end of a capped slice must be able to say so rather than
    // imply it has seen the whole store.
    truncated: storeExtract.records.truncated === true,
  };
  sendJson(res, 200, C.apiOk(page, meta), setCookie);
}

/** GET /api/persona */
function routePersona(res, setCookie) {
  const { root, snapshot } = currentSnapshot();
  const meta = envelopeMeta(snapshot);
  const summary = snapshot.persona || { status: C.STATUS.UNMEASURED, reason: "persona not summarised" };
  const raw = root.persona || {};
  sendJson(
    res, 200,
    C.apiOk({ ...summary, text: raw.text ?? null, path: path.join(effectiveRootDir, "global", "persona.md") }, meta),
    setCookie,
  );
}

/** GET /api/export?format=json */
function routeExport(res, url, setCookie) {
  const format = url.searchParams.get("format") || "json";
  const { snapshot } = currentSnapshot();
  const meta = envelopeMeta(snapshot);
  if (format !== "json") {
    sendJson(res, 400, C.apiError(C.API_ERROR.BAD_REQUEST, `unsupported format ${JSON.stringify(format)}`, meta), setCookie);
    return;
  }
  // Returned as a body, never written to disk. `--snapshot` is the only path that
  // produces a file, and it is the user's explicit request.
  let version = "unknown";
  try {
    version = require("../../package.json").version;
  } catch { /* not fatal */ }
  sendJson(
    res, 200,
    C.apiOk({
      snapshot,
      provenance: { tool: "tmem view", version, node: process.version, exportedAt: new Date().toISOString() },
    }, meta),
    { ...setCookie, "content-disposition": `inline; filename="tmem-${snapshot.snapshotId || "snapshot"}.json"` },
  );
}

/**
 * GET /api/recall?q=&slug=&limit=
 *
 * The ONLY route that does not go through extract/transform. It calls the real
 * `recallAsync()` the UserPromptSubmit hook calls, so what the Context lens shows
 * is the literal `<memory-context>` block the agent would receive — including its
 * budget truncation, its persona tier-1 line and its scene-nav block. A
 * reimplementation here would show what recall is SUPPOSED to inject, which is
 * exactly the class of statement this whole tool exists to stop trusting.
 *
 * The cost of using the real path is that it comes with the real path's own root
 * resolution: `recallAsync()` reads `memory_writer.globalDir()` / `projectDir()`
 * directly and takes no root argument, so it CANNOT follow `--root`. Measured: on
 * a fixture root holding a single sentinel record, `/api/snapshot` reported that
 * record while `/api/recall` could not see it and answered from the user's real
 * store instead. Left alone that is both a cross-view contradiction — the Context
 * lens describing a different store than every other lens — and a privacy leak,
 * since someone who pointed the viewer at a sanitised fixture would still have
 * their real prompts rendered. So the route refuses instead of answering; the
 * alternative fix lives in memory_recall.js, which this module does not own.
 */
async function routeRecall(res, url, setCookie) {
  const q = url.searchParams.get("q") || "";
  const slug = url.searchParams.get("slug") || "";
  const topK = clampInt(url.searchParams.get("limit"), 5, 1, 50);
  const maxTokens = clampInt(url.searchParams.get("maxTokens"), 280, 1, 4000);

  let meta = { snapshotId: null, generatedAt: new Date().toISOString() };
  try {
    meta = envelopeMeta(currentSnapshot().snapshot);
  } catch { /* recall does not need the pipeline; answer anyway */ }

  if (path.resolve(effectiveRootDir) !== path.resolve(memoryBaseDir())) {
    sendJson(
      res, 409,
      C.apiError(
        C.API_ERROR.BAD_REQUEST,
        `/api/recall is disabled when --root points away from the real store: recallAsync() ` +
        `resolves its own paths and would answer from ${memoryBaseDir()} while every other ` +
        `route reports ${effectiveRootDir}. Refusing rather than showing you two different stores.`,
        meta,
      ),
      setCookie,
    );
    return;
  }

  if (!q.trim()) {
    sendJson(res, 400, C.apiError(C.API_ERROR.BAD_REQUEST, "q is required", meta), setCookie);
    return;
  }

  // `global` is addressed by the empty project hash, matching recallAsync's own
  // convention (globalDir() is always searched; projectDir() only when non-empty).
  const projectHash = !slug || slug === "global" ? "" : slug;

  const t0 = process.hrtime.bigint();
  let injected = "";
  try {
    const { recallAsync } = require("../memory_recall.js");
    injected = await recallAsync(q, projectHash, maxTokens, topK);
  } catch (err) {
    sendJson(res, 500, C.apiError(C.API_ERROR.INTERNAL, `recallAsync failed: ${err.message}`, meta), setCookie);
    return;
  }
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const vectors = vectorCapability();

  /** @type {import('./contract.js').RecallResponse} */
  const payload = {
    q,
    hits: hitsFromInjectedBlock(injected, slug, vectors.status),
    vectorStatus: vectors.status,
    vectorReason: vectors.reason,
    injected,
    injectedChars: injected.length,
    tookMs,
    // NOT in the contract's RecallResponse, and added deliberately rather than
    // silently: recallAsync() returns only the rendered block, so per-hit
    // provenance (fts vs vector vs both, and the ranker's score) is not
    // observable from outside it. Saying "unmeasured" here is honest;
    // reconstructing it by re-running the search would make `hits` a
    // reimplementation and could disagree with `injected`.
    attribution: C.unmeasured(
      "recallAsync() returns a rendered block, not ranked hits — per-hit matchedBy/score " +
      "cannot be observed without changing the recall path",
    ),
  };
  sendJson(res, 200, C.apiOk(payload, meta), setCookie);
}

/**
 * Whether the vector half of recall could run at all, so the UI can say
 * "FTS-only" instead of implying a hybrid search happened. Asks two questions —
 * does any store have a vectors.db, and does sqlite-vec resolve — and counts
 * nothing.
 *
 * THIS FUNCTION USED TO CONSTRUCT A `VectorStore`, AND THAT WAS A REAL BUG.
 * `VectorStore`'s constructor is a writer: `fs.mkdirSync`, then a READ-WRITE
 * `DatabaseSync`, then `PRAGMA journal_mode=WAL`, then `_initSchema()` —
 * `CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec ... float[768]`. Probing capability
 * with it therefore MUTATED the store it was probing. Measured, on a fixture in
 * extract's own "vectors.db exists but has no l1_vec table" state, a single
 * `/api/recall` created `l1_vec` + 5 shadow tables + `vec_meta` at 768 dimensions
 * regardless of the store's real embedder, flipped `journal_mode` to WAL (a
 * header write) and left `-wal`/`-shm` behind. The store's next snapshot then
 * read `ok / withVector 0 / withoutVector 48 / ratio 0` where it had read
 * `unmeasured` — the visualiser manufacturing a measured 0% coverage, which is
 * precisely the false alarm contract.js's Source/Coverage machinery exists to
 * prevent, now caused by the tool that reports it. It also self-triggered the
 * watcher, since `fsFingerprint()` stats `vectors.db`.
 *
 * `extract.probeSqliteVec()` is the right instrument and was already exported:
 * memoised, and it opens no database at all. Combined with `listStores()` —
 * `existsSync` discovery, also no open — the whole probe is now stat-only, and
 * SQLite is reached through exactly one code path (`extract.openReadOnly()`)
 * instead of two.
 */
function vectorCapability() {
  const refs = storeRefs();
  if (!refs.length) return C.unmeasured("no stores discovered — recall ran FTS-only");
  // `vectorDbPath` is extract's own existence check; null means genuinely absent.
  if (!refs.some((r) => r.vectorDbPath)) {
    return C.unmeasured("no vectors.db present in any store — recall ran FTS-only");
  }

  const probe = pipeline().probeSqliteVec;
  if (!probe) {
    return C.unmeasured(
      `${missingPipelineMessage("probe")} — vector capability could not be determined`,
    );
  }
  try {
    const vec = probe();
    if (!vec || !vec.module) {
      return C.unmeasured(
        `sqlite-vec could not be resolved (${(vec && vec.reason) || "unknown"}) — recall ran FTS-only`,
      );
    }
    return C.ok();
  } catch (err) {
    return C.errored(err);
  }
}

/**
 * Parse the `<memories>` lines back out of the block recallAsync produced.
 *
 * Deriving hits FROM the rendered block rather than alongside it is the point:
 * whatever the UI lists is, by construction, exactly what was injected. Fields
 * the block does not carry (`id`, `score`) stay null rather than being guessed,
 * and `matchedBy` is only asserted when it is provable — when there was no
 * vector capability at all, "fts" is a fact.
 */
function hitsFromInjectedBlock(block, slug, vectorStatus) {
  const start = block.indexOf("<memories>");
  if (start === -1) return [];
  const end = block.indexOf("</memories>", start);
  const body = block.slice(start + "<memories>".length, end === -1 ? undefined : end);
  const hits = [];
  for (const line of body.split("\n")) {
    const m = /^-\s*\[([^\]]*)\]\s*([\s\S]*)$/.exec(line.trim());
    if (!m) continue;
    hits.push({
      id: null,
      slug: slug || "global",
      content: m[2],
      type: m[1] === "?" ? "other" : m[1],
      priority: null,
      matchedBy: vectorStatus === C.STATUS.OK ? null : "fts",
      score: null,
      injected: true, // parsed out of the injected block, so true by construction
    });
  }
  return hits;
}

/** GET /api/events — SSE. */
function routeEventsStream(req, res, setCookie) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...setCookie,
  });

  let snapshotId = lastKnownSnapshotId;
  let pipelineError = null;
  try {
    snapshotId = currentSnapshot().snapshot.snapshotId;
    lastKnownSnapshotId = snapshotId;
  } catch (err) {
    pipelineError = err.message;
  }

  res.write(`event: hello\ndata: ${JSON.stringify({
    at: Date.now(),
    snapshotId,
    pinned: PINNED,
    watchIntervalMs: PINNED ? null : WATCH_INTERVAL_MS,
    pipelineError,
  })}\n\n`);
  clients.add(res);

  // Browsers and proxies drop a silent event-stream; a comment every 25s holds it.
  const heartbeat = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * POST /api/events — record a UI interaction as JSONL for the agent's next turn.
 *
 * Same path as the SSE stream, split by method, precisely so this does not invent
 * a route the contract's ROUTES table does not name. This is the honest boundary
 * of "live": the page reacts immediately, but the agent only sees these when its
 * next turn runs and reads events.jsonl.
 *
 * It writes to the SESSION directory only. There is no route in this server that
 * writes to the memory store.
 */
async function routeEventsPost(req, res, setCookie) {
  let event;
  try {
    event = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, C.apiError(C.API_ERROR.BAD_REQUEST, err.message), setCookie);
    return;
  }
  let snapshotId = lastKnownSnapshotId;
  try { snapshotId = currentSnapshot().snapshot.snapshotId; } catch { /* keep last known */ }
  const line = JSON.stringify({
    ...event,
    snapshotId,
    at: new Date().toISOString(),
    timestamp: Math.floor(Date.now() / 1000),
  });
  fs.appendFileSync(EVENTS_PATH, `${line}\n`);
  sendJson(res, 200, C.apiOk({ recorded: true, eventsPath: EVENTS_PATH }, { snapshotId }), setCookie);
}

/** GET / — the frozen shell. */
let shellHtml = null;
function routeShell(res, setCookie) {
  if (shellHtml === null) {
    try {
      shellHtml = fs.readFileSync(SHELL_PATH, "utf8");
    } catch {
      // Degrade with something that says what is wrong and proves the API is up,
      // rather than a blank 500 that looks like the whole server is broken.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...setCookie });
      res.end(
        "<!doctype html><meta charset=utf-8><title>tmem view</title>" +
        "<body style=\"font:14px/1.6 ui-monospace,monospace;max-width:60ch;margin:4rem auto;padding:0 1rem\">" +
        "<h1>tmem view — shell missing</h1>" +
        `<p>The server is running and the API is live, but <code>${SHELL_PATH}</code> was not found, ` +
        "so there is no UI to render.</p>" +
        "<p>The API is reachable with the same session key you used to load this page:</p>" +
        "<ul>" +
        Object.values(C.ROUTES).map((r) => `<li><code>${r}</code></li>`).join("") +
        "</ul></body>",
      );
      return;
    }
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...setCookie,
  });
  res.end(shellHtml);
}

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

const STORE_RECORDS_RE = /^\/api\/store\/([^/]+)\/records$/;

const server = http.createServer(async (req, res) => {
  touch();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const isApi = url.pathname.startsWith("/api/");

  if (!authorized(req, url)) {
    deny(res, isApi);
    return;
  }

  // Only set the cookie when the key arrived in the query string; re-setting it on
  // every XHR is noise, and the cookie is what makes reloads work without ?key=.
  const setCookie =
    url.searchParams.get("key") === KEY
      ? { "set-cookie": `${COOKIE_NAME}=${KEY}; Path=/; SameSite=Strict; HttpOnly` }
      : {};

  try {
    if (url.pathname === "/" && req.method === "GET") return routeShell(res, setCookie);

    // Asked for unprompted by the browser; 204 keeps the only console error off a
    // page whose whole job is making real problems visible.
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, setCookie);
      return res.end();
    }

    if (url.pathname === C.ROUTES.EVENTS) {
      if (req.method === "GET") return routeEventsStream(req, res, setCookie);
      if (req.method === "POST") return routeEventsPost(req, res, setCookie);
      return sendJson(res, 405, C.apiError(C.API_ERROR.BAD_REQUEST, `${req.method} not allowed on ${C.ROUTES.EVENTS}`), setCookie);
    }

    if (req.method !== "GET" && isApi) {
      return sendJson(res, 405, C.apiError(C.API_ERROR.BAD_REQUEST, `${req.method} not allowed`), setCookie);
    }

    if (url.pathname === C.ROUTES.SNAPSHOT) return routeSnapshot(res, setCookie);
    if (url.pathname === C.ROUTES.PERSONA) return routePersona(res, setCookie);
    if (url.pathname === C.ROUTES.EXPORT) return routeExport(res, url, setCookie);
    if (url.pathname === C.ROUTES.RECALL) return routeRecall(res, url, setCookie);

    const m = STORE_RECORDS_RE.exec(url.pathname);
    if (m) return routeStoreRecords(res, url, decodeURIComponent(m[1]), setCookie);

    if (isApi) {
      return sendJson(res, 404, C.apiError(C.API_ERROR.NOT_FOUND, `no route ${url.pathname}`), setCookie);
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404\n");
  } catch (err) {
    // A pipeline that cannot load is reported as such, by name, on every route it
    // affects — never as an empty payload that reads like "the store is empty".
    if (!res.headersSent) sendJson(res, 500, C.apiError(C.API_ERROR.INTERNAL, err.message));
    else try { res.end(); } catch { /* already gone */ }
  }
});

function start() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  startWatcher();
  startIdleTimer();
  server.listen(PORT, HOST, onListening);
}

function onListening() {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  const url = `http://${URL_HOST}:${port}/?key=${KEY}`;

  // Prime the cache off the request path so the first page load is not the thing
  // that pays 65 ms, and so a broken pipeline is reported at startup.
  let snapshotId = null;
  let pipelineError = null;
  let primeMs = null;
  try {
    const primed = currentSnapshot();
    snapshotId = primed.snapshot.snapshotId || null;
    primeMs = Number(primed.ms.toFixed(1));
    lastKnownSnapshotId = snapshotId;
    lastFingerprint = cache ? cache.fingerprint : null;
  } catch (err) {
    pipelineError = err.message;
  }

  const info = {
    type: "server-started",
    pid: process.pid,
    port,
    host: HOST,
    url,
    rootDir: effectiveRootDir,
    rootDirRequested: ROOT_DIR,
    sessionDir: SESSION_DIR,
    eventsPath: EVENTS_PATH,
    infoPath: INFO_PATH,
    idleTimeoutMinutes: IDLE_MINUTES,
    mode: PINNED ? "pinned" : "live",
    snapshotId,
    pipelineMs: primeMs,
    pipelineError,
    routes: C.ROUTES,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(INFO_PATH, `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(info)}\n`);
  // Printed separately and last so it is the thing a human sees and can paste.
  process.stdout.write(`\ntmem view ready — open this URL verbatim (the key is required):\n  ${url}\n`);
  if (pipelineError) process.stderr.write(`tmem-view: ${pipelineError}\n`);
}

function shutdown() {
  try {
    fs.writeFileSync(path.join(SESSION_DIR, "server-stopped"), `${new Date().toISOString()}\n`);
  } catch {
    /* best effort */
  }
  process.exit(0);
}

// Requiring this module must not start a listener or touch the filesystem — the
// exports below exist so a test can exercise the pure parts in isolation.
if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  start();
}

module.exports = { start, server, fsFingerprint, hitsFromInjectedBlock, vectorCapability, PIPELINE_API, ROOT_DIR, SESSION_DIR };
