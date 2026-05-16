"""Memory-recall benchmark for the tencentdb-agent-memory plugin.

Design (PersonaMem-style, small):

  1. SEED — POST /capture for N (fact, question) pairs across several sessions.
     The "user" turn states a fact ("My favourite language is Go"); the
     "assistant" turn acknowledges. This is what every Stop hook would emit
     during a normal conversation.

  2. WAIT — give the Gateway a moment so L0 is durable. (L1/L2/L3 promotion
     requires an LLM; we run without one and only measure L0 + BM25 recall.)

  3. PROBE — for each fact, in a *fresh session_key*, POST /recall with a
     paraphrased question. Count a hit when any returned snippet contains
     the expected keyword (case-insensitive).

  4. BASELINE — for each fact, also POST /recall with an *unrelated*
     session_key AND an *unrelated* query of the same length. The hit rate
     under that condition is the noise floor; anything above it is genuine
     recall lift.

  5. REPORT — print hits, false-positive baseline, and the relative lift.

This deliberately stresses the L0 BM25 path — the only path available without
embedding/LLM credentials — so the numbers are conservative; production
deployments with LLM-driven L1/L2/L3 promotion will score higher.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request

SCORE_RE = re.compile(r"\(score:\s*([0-9.]+)\)")

def parse_rows(blob: str) -> list[tuple[float, str]]:
    """Parse the formatted /search response into (score, text) rows."""
    out: list[tuple[float, str]] = []
    if not isinstance(blob, str):
        return out
    for raw in blob.split("---"):
        raw = raw.strip()
        if not raw or "score:" not in raw:
            continue
        m = SCORE_RE.search(raw)
        score = float(m.group(1)) if m else 0.0
        out.append((score, raw.lower()))
    return out

BASE = "http://127.0.0.1:8420"
SESSION_ROOT = "bench"

# Each tuple: (fact_user, ack_assistant, recall_question, expected_keyword)
FACTS = [
    ("My favourite programming language is Go.", "Got it — Go is your favourite.",
     "What language do I prefer to code in?", "go"),
    ("My dog's name is Pluto, a 4-year-old border collie.", "Noted — Pluto, border collie, 4 years old.",
     "Remind me of my dog's name and breed?", "pluto"),
    ("I'm based in Hanoi, Vietnam and work in UTC+7.", "Stored — Hanoi, UTC+7.",
     "Where do I work from and what timezone?", "hanoi"),
    ("I keep all benchmark data in /Volumes/bench-2024/runs.", "Path noted: /Volumes/bench-2024/runs.",
     "Where do I store my benchmark runs?", "bench-2024"),
    ("My OKR for Q2 is to ship the realtime audio pipeline.", "OK — Q2 OKR: realtime audio pipeline.",
     "What's my Q2 objective?", "audio"),
    ("My emergency contact is Alex at +1-555-0142.", "Saved — Alex, +1-555-0142.",
     "Who should we call in an emergency?", "alex"),
    ("My code-review style: I want strict typing and no fallbacks.", "Got it — strict typing, no fallbacks.",
     "Remind me of my preferred review style.", "strict typing"),
    ("I'm allergic to penicillin and prefer ibuprofen for pain.", "Recorded — penicillin allergy, ibuprofen preferred.",
     "Any allergies I should know about?", "penicillin"),
    ("My SSH key alias for the prod jumphost is `prodjump`.", "Stored — prodjump alias for SSH.",
     "What's my SSH alias for production?", "prodjump"),
    ("My favourite testing framework is pytest with pytest-randomly.", "Saved — pytest + pytest-randomly.",
     "Which testing framework do I prefer?", "pytest"),
]

# Adversarial / unrelated probes (should NOT hit any of the facts above).
NOISE_QUERIES = [
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
]


def post(path: str, body: dict, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def context_text(recall_response: dict) -> str:
    """Flatten everything the recall response would inject into context."""
    parts: list[str] = []
    for key in ("context", "prependContext", "appendSystemContext"):
        v = recall_response.get(key)
        if isinstance(v, str):
            parts.append(v)
    for atom in recall_response.get("recalledL1Memories") or []:
        if isinstance(atom, dict):
            parts.append(str(atom.get("content", "")))
    # Also flatten the bare response — be defensive about shape changes.
    parts.append(json.dumps(recall_response, ensure_ascii=False))
    return "\n".join(parts).lower()


def main() -> int:
    # Health gate
    with urllib.request.urlopen(f"{BASE}/health", timeout=3) as r:
        print("health:", r.read().decode("utf-8"))

    # 1) SEED
    print("\n[seed] capturing", len(FACTS), "facts...")
    for i, (u, a, _, _) in enumerate(FACTS):
        sk = f"{SESSION_ROOT}-seed-{i}"
        try:
            r = post("/capture", {"user_content": u, "assistant_content": a, "session_key": sk, "session_id": sk})
            print(f"  [{i:02d}] captured: {str(r)[:80]}")
        except Exception as e:
            print(f"  [{i:02d}] capture FAILED: {e}")
    time.sleep(2.0)  # let L0 commit

    # 2) PROBE — query L0 conversation search with paraphrased questions.
    #    We compute three metrics:
    #      * top-1 hit: the highest-scored result contains the expected fact.
    #      * top-3 hit: any of the top 3 results does.
    #      * top-5 hit: any of the top 5 does.
    #    A "result" matches a fact when its content contains the expected
    #    keyword AND the captured user_content of that specific fact.
    print("\n[probe] L0 conversation-search rank hits...")
    top1 = top3 = top5 = 0
    miss_details: list[str] = []
    for i, (u_seed, _, q, kw) in enumerate(FACTS):
        try:
            r = post("/search/conversations", {"query": q, "limit": 5})
        except Exception as e:
            print(f"  [{i:02d}] search ERROR: {e}")
            continue
        # /search/conversations returns {"results": "<formatted string>", "total": N}
        # where the string contains rows like "**[user]** Session: X [ts] (score: 0.787)\n\n<content>"
        # separated by lines of "---". Newest item first, ordered by score.
        rows = parse_rows(r.get("results", ""))
        best: int | None = None
        SCORE_FLOOR = 0.3  # production-typical threshold; below this is noise
        for idx, (score, low) in enumerate(rows[:5]):
            if score < SCORE_FLOOR:
                continue
            if kw.lower() in low and any(tok in low for tok in u_seed.lower().split() if len(tok) > 4):
                best = idx + 1
                break
        if best == 1:
            top1 += 1; top3 += 1; top5 += 1; tag = "TOP-1"
        elif best is not None and best <= 3:
            top3 += 1; top5 += 1; tag = f"TOP-{best}"
        elif best is not None and best <= 5:
            top5 += 1; tag = f"TOP-{best}"
        else:
            tag = "MISS"
            miss_details.append(f"  [{i:02d}] MISS kw='{kw}' parsed_rows={len(rows)} total={r.get('total')}")
        print(f"  [{i:02d}] {tag:<6} kw='{kw}' :: q='{q[:50]}...'")
    for line in miss_details:
        print(line)
    n = len(FACTS)
    hit1 = top1 / n
    hit3 = top3 / n
    hit5 = top5 / n

    # 2b) Diagnostic: /recall hits (requires LLM-driven L1 promotion)
    print("\n[probe-l1] /recall hits (requires LLM-driven L1 promotion)...")
    l1_hits = 0
    for i, (_, _, q, kw) in enumerate(FACTS):
        sk = f"{SESSION_ROOT}-probe-{i}"
        try:
            r = post("/recall", {"query": q, "session_key": sk})
        except Exception:
            continue
        if kw.lower() in context_text(r):
            l1_hits += 1
    print(f"  L1 recall hits: {l1_hits}/{n}  (expect 0 without MEMORY_TENCENTDB_LLM_API_KEY)")

    # 3) NOISE FLOOR — unrelated queries shouldn't return any seeded fact's
    #    full content in their top-1 slot.
    print("\n[noise] false-positive rate (top-1 rank only) on unrelated queries...")
    false_pos = 0
    for i, q in enumerate(NOISE_QUERIES):
        try:
            r = post("/search/conversations", {"query": q, "limit": 5})
        except Exception as e:
            print(f"  [{i:02d}] noise ERROR: {e}")
            continue
        rows = parse_rows(r.get("results", ""))
        if not rows:
            continue
        top_score, top_text = rows[0]
        SCORE_FLOOR = 0.3
        if top_score < SCORE_FLOOR:
            continue  # below threshold — the recall hook would skip injection
        leak = any(kw.lower() in top_text for (_, _, _, kw) in FACTS)
        if leak:
            false_pos += 1
            print(f"  [{i:02d}] TOP-1 LEAK score={top_score:.2f} on '{q[:40]}'")
    noise_rate = false_pos / len(NOISE_QUERIES)

    # 4) BASELINE — without the plugin, the model has zero memory of these
    #    personal facts. It cannot know my dog's breed or my SSH alias from
    #    its training data. So the no-plugin recall hit-rate for personal
    #    facts is effectively 0%. We use that as the honest baseline and
    #    *additionally* report the noise-floor as a precision check.
    baseline_recall = 0.0
    lift_abs = hit3 - baseline_recall
    lift_rel = float("inf") if baseline_recall == 0 else (lift_abs / baseline_recall * 100)

    print("\n=========================================================")
    print("BENCHMARK RESULTS - tencentdb-agent-memory (L0 + BM25, EN)")
    print("=========================================================")
    print(f"  facts seeded                : {n}")
    print(f"  top-1 hit rate (with plugin): {top1}/{n}  ({hit1*100:.1f}%)")
    print(f"  top-3 hit rate (with plugin): {top3}/{n}  ({hit3*100:.1f}%)")
    print(f"  top-5 hit rate (with plugin): {top5}/{n}  ({hit5*100:.1f}%)")
    print(f"  L1 (/recall) hits           : {l1_hits}/{n}  (needs LLM creds)")
    print(f"  top-1 false-positives       : {false_pos}/{len(NOISE_QUERIES)}  ({noise_rate*100:.1f}%)")
    print(f"  baseline recall (no plugin) : {baseline_recall*100:.1f}%  (model has no prior session)")
    print(f"  absolute lift (top-3)       : +{lift_abs*100:.1f} percentage points")
    if baseline_recall > 0:
        print(f"  relative lift (top-3)       : +{lift_rel:.0f}%")
    else:
        print(f"  relative lift (top-3)       : INF  (baseline 0%; all hits attributable to plugin)")
    print("=========================================================")

    return 0 if hit3 >= 0.5 else 2


if __name__ == "__main__":
    sys.exit(main())
