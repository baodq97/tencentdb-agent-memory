#!/usr/bin/env node
/**
 * Memory-recall benchmark for the tencentdb-agent-memory plugin.
 *
 * PersonaMem-style: SEED → WAIT → PROBE → NOISE → REPORT
 *
 * Usage:
 *   node scripts/benchmark.js
 */
"use strict";

const http = require("node:http");

const BASE = "http://127.0.0.1:8420";
const SESSION_ROOT = "bench";

const FACTS = [
  ["My favourite programming language is Go.", "Got it — Go is your favourite.",
   "What language do I prefer to code in?", "go"],
  ["My dog's name is Pluto, a 4-year-old border collie.", "Noted — Pluto, border collie, 4 years old.",
   "Remind me of my dog's name and breed?", "pluto"],
  ["I'm based in Hanoi, Vietnam and work in UTC+7.", "Stored — Hanoi, UTC+7.",
   "Where do I work from and what timezone?", "hanoi"],
  ["I keep all benchmark data in /Volumes/bench-2024/runs.", "Path noted: /Volumes/bench-2024/runs.",
   "Where do I store my benchmark runs?", "bench-2024"],
  ["My OKR for Q2 is to ship the realtime audio pipeline.", "OK — Q2 OKR: realtime audio pipeline.",
   "What's my Q2 objective?", "audio"],
  ["My emergency contact is Alex at +1-555-0142.", "Saved — Alex, +1-555-0142.",
   "Who should we call in an emergency?", "alex"],
  ["My code-review style: I want strict typing and no fallbacks.", "Got it — strict typing, no fallbacks.",
   "Remind me of my preferred review style.", "strict typing"],
  ["I'm allergic to penicillin and prefer ibuprofen for pain.", "Recorded — penicillin allergy, ibuprofen preferred.",
   "Any allergies I should know about?", "penicillin"],
  ["My SSH key alias for the prod jumphost is `prodjump`.", "Stored — prodjump alias for SSH.",
   "What's my SSH alias for production?", "prodjump"],
  ["My favourite testing framework is pytest with pytest-randomly.", "Saved — pytest + pytest-randomly.",
   "Which testing framework do I prefer?", "pytest"],
];

const NOISE_QUERIES = [
  "What is the speed of light?",
  "Tell me a recipe for sourdough.",
  "Who won the 1998 World Cup?",
  "What's the chemical formula of water?",
  "Recommend a movie from the 1980s.",
  "How do I tie a bowline knot?",
  "What's the airspeed velocity of an unladen swallow?",
  "Explain the Krebs cycle in one sentence.",
  "Best route from Paris to Berlin by train?",
  "What's the population of Iceland?",
];

function post(urlPath, body, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}${urlPath}`);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

const SCORE_RE = /\(score:\s*([0-9.]+)\)/;

function parseRows(blob) {
  if (typeof blob !== "string") return [];
  return blob.split("---").map((raw) => {
    raw = raw.trim();
    if (!raw || !raw.includes("score:")) return null;
    const m = raw.match(SCORE_RE);
    return { score: m ? parseFloat(m[1]) : 0, text: raw.toLowerCase() };
  }).filter(Boolean);
}

function contextText(resp) {
  const parts = [];
  for (const key of ["context", "prependContext", "appendSystemContext"]) {
    if (typeof resp[key] === "string") parts.push(resp[key]);
  }
  for (const atom of resp.recalledL1Memories || []) {
    if (atom?.content) parts.push(String(atom.content));
  }
  parts.push(JSON.stringify(resp));
  return parts.join("\n").toLowerCase();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const healthResp = await new Promise((resolve, reject) => {
    http.get(`${BASE}/health`, { timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
  console.log("health:", healthResp);

  const n = FACTS.length;

  // 1) SEED
  console.log(`\n[seed] capturing ${n} facts...`);
  for (let i = 0; i < n; i++) {
    const [u, a] = FACTS[i];
    const sk = `${SESSION_ROOT}-seed-${i}`;
    try {
      const r = await post("/capture", { user_content: u, assistant_content: a, session_key: sk, session_id: sk });
      console.log(`  [${String(i).padStart(2, "0")}] captured: ${JSON.stringify(r).slice(0, 80)}`);
    } catch (e) {
      console.log(`  [${String(i).padStart(2, "0")}] capture FAILED: ${e.message}`);
    }
  }
  await sleep(2000);

  // 2) PROBE
  console.log("\n[probe] L0 conversation-search rank hits...");
  let top1 = 0, top3 = 0, top5 = 0;
  const misses = [];
  const SCORE_FLOOR = 0.3;
  for (let i = 0; i < n; i++) {
    const [uSeed, , q, kw] = FACTS[i];
    let r;
    try { r = await post("/search/conversations", { query: q, limit: 5 }); } catch (e) { console.log(`  [${String(i).padStart(2, "0")}] search ERROR: ${e.message}`); continue; }
    const rows = parseRows(r.results || "");
    let best = null;
    for (let idx = 0; idx < Math.min(rows.length, 5); idx++) {
      if (rows[idx].score < SCORE_FLOOR) continue;
      const low = rows[idx].text;
      if (low.includes(kw.toLowerCase()) && uSeed.toLowerCase().split(/\s+/).some((t) => t.length > 4 && low.includes(t.toLowerCase()))) {
        best = idx + 1; break;
      }
    }
    let tag;
    if (best === 1) { top1++; top3++; top5++; tag = "TOP-1"; }
    else if (best && best <= 3) { top3++; top5++; tag = `TOP-${best}`; }
    else if (best && best <= 5) { top5++; tag = `TOP-${best}`; }
    else { tag = "MISS"; misses.push(`  [${String(i).padStart(2, "0")}] MISS kw='${kw}' parsed_rows=${rows.length} total=${r.total}`); }
    console.log(`  [${String(i).padStart(2, "0")}] ${tag.padEnd(6)} kw='${kw}' :: q='${q.slice(0, 50)}...'`);
  }
  for (const l of misses) console.log(l);

  // 2b) L1 recall diagnostic
  console.log("\n[probe-l1] /recall hits (requires LLM-driven L1 promotion)...");
  let l1Hits = 0;
  for (let i = 0; i < n; i++) {
    const [, , q, kw] = FACTS[i];
    try {
      const r = await post("/recall", { query: q, session_key: `${SESSION_ROOT}-probe-${i}` });
      if (contextText(r).includes(kw.toLowerCase())) l1Hits++;
    } catch {}
  }
  console.log(`  L1 recall hits: ${l1Hits}/${n}  (expect 0 without MEMORY_TENCENTDB_LLM_API_KEY)`);

  // 3) NOISE
  console.log("\n[noise] false-positive rate (top-1 rank only) on unrelated queries...");
  let falsePos = 0;
  for (let i = 0; i < NOISE_QUERIES.length; i++) {
    let r;
    try { r = await post("/search/conversations", { query: NOISE_QUERIES[i], limit: 5 }); } catch (e) { console.log(`  [${String(i).padStart(2, "0")}] noise ERROR: ${e.message}`); continue; }
    const rows = parseRows(r.results || "");
    if (!rows.length || rows[0].score < SCORE_FLOOR) continue;
    if (FACTS.some(([, , , kw]) => rows[0].text.includes(kw.toLowerCase()))) {
      falsePos++;
      console.log(`  [${String(i).padStart(2, "0")}] TOP-1 LEAK score=${rows[0].score.toFixed(2)} on '${NOISE_QUERIES[i].slice(0, 40)}'`);
    }
  }

  const hit1 = top1 / n, hit3 = top3 / n, hit5 = top5 / n;
  const noiseRate = falsePos / NOISE_QUERIES.length;

  console.log("\n=========================================================");
  console.log("BENCHMARK RESULTS - tencentdb-agent-memory (L0 + BM25, EN)");
  console.log("=========================================================");
  console.log(`  facts seeded                : ${n}`);
  console.log(`  top-1 hit rate (with plugin): ${top1}/${n}  (${(hit1 * 100).toFixed(1)}%)`);
  console.log(`  top-3 hit rate (with plugin): ${top3}/${n}  (${(hit3 * 100).toFixed(1)}%)`);
  console.log(`  top-5 hit rate (with plugin): ${top5}/${n}  (${(hit5 * 100).toFixed(1)}%)`);
  console.log(`  L1 (/recall) hits           : ${l1Hits}/${n}  (needs LLM creds)`);
  console.log(`  top-1 false-positives       : ${falsePos}/${NOISE_QUERIES.length}  (${(noiseRate * 100).toFixed(1)}%)`);
  console.log(`  baseline recall (no plugin) : 0.0%  (model has no prior session)`);
  console.log(`  absolute lift (top-3)       : +${(hit3 * 100).toFixed(1)} percentage points`);
  console.log(`  relative lift (top-3)       : INF  (baseline 0%)`);
  console.log("=========================================================");

  process.exit(hit3 >= 0.5 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
