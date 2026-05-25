# Self-Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user's own agent (Claude Code / Codex / Copilot) extract L1/L2/L3 memories from L0 raw conversations, with zero paid LLM or embedding API keys.

**Architecture:** UA-style multi-agent pipeline orchestrated by a SKILL.md. A reader script scans L0 JSONL, dispatches extraction to parallel subagents, merges results, then writes directly to the Gateway's data directory (JSONL + SQLite FTS + scene markdown + persona markdown).

**Tech Stack:** Python 3.10+ stdlib (json, sqlite3, pathlib, http), Claude Code plugin conventions (agents/*.md, skills/*/SKILL.md, commands/*.md)

---

## File Map

| File | Responsibility |
|---|---|
| `scripts/consolidate_reader.py` | Read L0 JSONL + SQLite, output formatted conversations for extraction |
| `agents/memory-extractor.md` | Subagent: extract L1 atoms from a batch of conversation turns |
| `skills/memory-consolidation/merge-memories.py` | Merge batch JSONs, fuzzy-dedup by content similarity |
| `skills/memory-consolidation/write-results.py` | Write L1 to JSONL + SQLite FTS, L2 to scene_blocks/*.md, L3 to persona.md |
| `agents/scene-builder.md` | Subagent: group L1 atoms into L2 scene blocks |
| `agents/persona-builder.md` | Subagent: generate L3 persona from scenes + atoms |
| `agents/memory-reviewer.md` | Subagent: validate all extracted data for consistency |
| `skills/memory-consolidation/SKILL.md` | Orchestrator: 7-phase pipeline |
| `commands/memory-consolidate.md` | Slash command entry point |

---

### Task 1: L0 Conversation Reader

**Files:**
- Create: `scripts/consolidate_reader.py`

This script reads L0 raw conversations from the Gateway's data directory and outputs them as structured JSON for extraction agents.

- [ ] **Step 1: Create consolidate_reader.py**

```python
"""Read L0 conversations from the Gateway data directory.

Usage:
    python consolidate_reader.py [--data-dir DIR] [--since ISO8601] [--limit N]

Reads JSONL files from {data_dir}/conversations/*.jsonl (one message per line,
L0MessageRecord format from upstream l0-recorder.ts).

Outputs JSON to stdout:
{
  "conversations": [{"session_key": "...", "messages": [...]}],
  "total_messages": N,
  "sessions": N
}
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


DEFAULT_DATA_DIR = str(
    Path.home() / ".memory-tencentdb" / "memory-tdai"
)


def resolve_data_dir() -> str:
    return os.environ.get("TDAI_DATA_DIR", DEFAULT_DATA_DIR)


def read_l0_jsonl(data_dir: str, since: str | None, limit: int) -> dict:
    conv_dir = Path(data_dir) / "conversations"
    if not conv_dir.is_dir():
        return {"conversations": [], "total_messages": 0, "sessions": 0}

    by_session: dict[str, list[dict]] = defaultdict(list)
    total = 0

    for fpath in sorted(conv_dir.glob("*.jsonl")):
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if since and rec.get("recordedAt", "") <= since:
                    continue

                sk = rec.get("sessionKey", "unknown")
                by_session[sk].append({
                    "id": rec.get("id", ""),
                    "role": rec.get("role", ""),
                    "content": rec.get("content", ""),
                    "timestamp": rec.get("recordedAt", rec.get("timestamp", "")),
                })
                total += 1

    conversations = []
    for sk, msgs in by_session.items():
        msgs.sort(key=lambda m: m["timestamp"])
        if limit > 0:
            msgs = msgs[:limit]
        conversations.append({"session_key": sk, "messages": msgs})

    return {
        "conversations": conversations,
        "total_messages": total,
        "sessions": len(conversations),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read L0 conversations")
    parser.add_argument("--data-dir", default=resolve_data_dir())
    parser.add_argument("--since", default=None, help="ISO8601 cutoff")
    parser.add_argument("--limit", type=int, default=0, help="Max messages per session")
    args = parser.parse_args()

    result = read_l0_jsonl(args.data_dir, args.since, args.limit)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke test**

Run: `python scripts/consolidate_reader.py --data-dir /nonexistent`
Expected: `{"conversations": [], "total_messages": 0, "sessions": 0}`

- [ ] **Step 3: Commit**

```bash
git add scripts/consolidate_reader.py
git commit -m "feat: add L0 conversation reader for self-consolidation"
```

---

### Task 2: Memory Extractor Agent

**Files:**
- Create: `agents/memory-extractor.md`

Subagent that receives a batch of conversation messages and extracts L1 memory atoms. Uses the upstream extraction prompt logic (translated to English).

- [ ] **Step 1: Create agents/memory-extractor.md**

```markdown
---
name: memory-extractor
description: Extract structured L1 memory atoms from a batch of conversation messages. Dispatched by the memory-consolidation skill during Phase 2. Receives formatted conversations and outputs JSON with scene-segmented memories.
model: inherit
color: cyan
tools: ["Read", "Write", "Bash"]
---

You are a memory extraction specialist. Your job is to analyze conversation messages and extract structured core memories (persona, episodic, instruction types only).

## Task 1: Scene Segmentation

Analyze the conversation messages provided to you and identify scene boundaries:
- **Inherit** the previous scene if no clear topic change
- **Switch** when the user issues a new goal, changes topic, or gives an explicit redirect
- **Naming**: "AI helping [user role] with [goal activity]" — English, 30-50 chars, globally unique

## Task 2: Core Memory Extraction

From the messages, extract ONLY memories that would remain valid outside this conversation.

### Three types (strict):

1. **persona** (priority 50-100): Stable user attributes, preferences, skills, values
   - Pattern: "User [name] prefers/is/excels at..."
   - 80-100: health/dietary/core traits; 50-70: general preferences; <50: discard

2. **episodic** (priority 60-100): Objective events, decisions, plans, outcomes
   - Pattern: "User [name] on [date] at [place] [did something (cause/process/result)]"
   - Derive absolute timestamps from message timestamps when possible
   - 80-100: important events; 60-70: routine activities; <60: discard

3. **instruction** (priority 70-100 or -1): Long-term behavior rules for AI
   - Pattern: "User wants/requires AI to always..."
   - Triggers: "from now on", "always", "remember", "must"
   - -1: absolute hard rules; 90-100: core behavior rules; <70: discard

### Do NOT extract:
- Trivial chatter, greetings
- One-time tool requests ("translate this for me")
- One-shot operational commands
- Duplicate content
- AI's own behaviors or outputs
- Pure subjective feelings without objective events

### Principles:
- Quality over quantity: filter aggressively
- Self-contained: each memory must make sense without conversation context
- Consolidate: merge strongly related messages into one complete memory

## Task 3: Output Format

Write a single valid JSON file to the output path given in your dispatch prompt. The JSON is an array of scene objects:

```json
[
  {
    "scene_name": "AI helping developer configure IDE preferences",
    "message_ids": ["msg_001", "msg_002"],
    "memories": [
      {
        "content": "User prefers dark mode in all development tools",
        "type": "persona",
        "priority": 70,
        "source_message_ids": ["msg_001"],
        "metadata": {}
      }
    ]
  }
]
```

For episodic memories with known times:
```json
"metadata": {"activity_start_time": "2025-05-25T10:00:00Z", "activity_end_time": "2025-05-25T11:00:00Z"}
```

If no meaningful memories exist, still output the scene with an empty `memories` array.

Output ONLY the JSON array. No markdown fences, no explanation text.
```

- [ ] **Step 2: Commit**

```bash
git add agents/memory-extractor.md
git commit -m "feat: add memory-extractor subagent for L1 extraction"
```

---

### Task 3: Merge + Dedup Script

**Files:**
- Create: `skills/memory-consolidation/merge-memories.py`

Merges batch JSON files from parallel extractors, deduplicates by content similarity.

- [ ] **Step 1: Create directory and script**

```bash
mkdir -p skills/memory-consolidation
```

```python
"""Merge batch extraction results and deduplicate memories.

Usage:
    python merge-memories.py <intermediate_dir>

Reads: intermediate/batch-*.json
Writes: intermediate/merged-memories.json

Dedup strategy: exact content match + fuzzy prefix match (first 60 chars).
"""
from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path


def load_batches(intermediate_dir: str) -> list[dict]:
    pattern = str(Path(intermediate_dir) / "batch-*.json")
    all_scenes: list[dict] = []
    for fpath in sorted(glob.glob(pattern)):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                all_scenes.extend(data)
            elif isinstance(data, dict) and "scenes" in data:
                all_scenes.extend(data["scenes"])
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: skipping {fpath}: {e}", file=sys.stderr)
    return all_scenes


def dedup_memories(scenes: list[dict]) -> list[dict]:
    seen_exact: set[str] = set()
    seen_prefix: set[str] = set()
    deduped_scenes: list[dict] = []

    for scene in scenes:
        unique_memories = []
        for mem in scene.get("memories", []):
            content = mem.get("content", "").strip()
            if not content:
                continue
            if content in seen_exact:
                continue
            prefix = content[:60].lower()
            if prefix in seen_prefix:
                continue
            seen_exact.add(content)
            seen_prefix.add(prefix)
            unique_memories.append(mem)
        scene["memories"] = unique_memories
        deduped_scenes.append(scene)

    return deduped_scenes


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: merge-memories.py <intermediate_dir>", file=sys.stderr)
        return 64

    intermediate_dir = sys.argv[1]
    scenes = load_batches(intermediate_dir)
    if not scenes:
        print("Warning: no batch files found", file=sys.stderr)

    deduped = dedup_memories(scenes)

    total_memories = sum(len(s.get("memories", [])) for s in deduped)
    total_scenes = len(deduped)
    print(f"Merged: {total_scenes} scenes, {total_memories} memories", file=sys.stderr)

    out_path = Path(intermediate_dir) / "merged-memories.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(deduped, f, ensure_ascii=False, indent=2)

    print(json.dumps({"scenes": total_scenes, "memories": total_memories}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Commit**

```bash
git add skills/memory-consolidation/merge-memories.py
git commit -m "feat: add merge + dedup script for extraction batches"
```

---

### Task 4: Write Results Script

**Files:**
- Create: `skills/memory-consolidation/write-results.py`

Writes L1 atoms to JSONL + SQLite FTS, L2 scenes to markdown, L3 persona to file.

- [ ] **Step 1: Create write-results.py**

```python
"""Write consolidated memory results to the Gateway data directory.

Usage:
    python write-results.py <data_dir> <intermediate_dir>

Reads:
  - intermediate/merged-memories.json (L1 atoms inside scenes)
  - intermediate/scenes.json (L2 scene blocks)
  - intermediate/persona.md (L3 persona)

Writes:
  - {data_dir}/records/YYYY-MM-DD.jsonl (L1 JSONL append)
  - {data_dir}/scene_blocks/*.md (L2 scene files)
  - {data_dir}/persona.md (L3 persona)
  - Inserts into {data_dir}/vectors.db l1_records + l1_fts tables
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def generate_memory_id() -> str:
    return f"m_{int(time.time() * 1000)}_{secrets.token_hex(4)}"


def write_l1_jsonl(data_dir: str, memories: list[dict], session_key: str) -> list[dict]:
    records_dir = Path(data_dir) / "records"
    records_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    jsonl_path = records_dir / f"{today}.jsonl"
    now = datetime.now(timezone.utc).isoformat()

    written: list[dict] = []
    with open(jsonl_path, "a", encoding="utf-8") as f:
        for mem in memories:
            record = {
                "id": generate_memory_id(),
                "content": mem["content"],
                "type": mem.get("type", "persona"),
                "priority": mem.get("priority", 50),
                "scene_name": mem.get("scene_name", ""),
                "source_message_ids": mem.get("source_message_ids", []),
                "metadata": mem.get("metadata", {}),
                "timestamps": [now],
                "createdAt": now,
                "updatedAt": now,
                "sessionKey": session_key,
                "sessionId": "",
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            written.append(record)
            time.sleep(0.002)

    return written


def write_l1_sqlite(data_dir: str, records: list[dict]) -> int:
    db_path = Path(data_dir) / "vectors.db"
    if not db_path.exists():
        print(f"Warning: {db_path} not found, skipping SQLite write", file=sys.stderr)
        return 0

    conn = sqlite3.connect(str(db_path))
    inserted = 0
    try:
        for rec in records:
            now = rec["updatedAt"]
            ts_start = ""
            ts_end = ""
            meta = rec.get("metadata", {})
            if isinstance(meta, dict):
                ts_start = meta.get("activity_start_time", "")
                ts_end = meta.get("activity_end_time", "")

            conn.execute(
                """INSERT OR REPLACE INTO l1_records
                   (record_id, content, type, priority, scene_name,
                    session_key, session_id, timestamp_str, timestamp_start,
                    timestamp_end, created_time, updated_time, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rec["id"], rec["content"], rec["type"], rec["priority"],
                    rec["scene_name"], rec["sessionKey"], rec.get("sessionId", ""),
                    now, ts_start, ts_end, now, now,
                    json.dumps(rec.get("metadata", {}), ensure_ascii=False),
                ),
            )

            try:
                conn.execute(
                    """INSERT INTO l1_fts
                       (content, content_original, record_id, type, priority,
                        scene_name, session_key, session_id, timestamp_str,
                        timestamp_start, timestamp_end, metadata_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        rec["content"], rec["content"], rec["id"], rec["type"],
                        str(rec["priority"]), rec["scene_name"], rec["sessionKey"],
                        rec.get("sessionId", ""), now, ts_start, ts_end,
                        json.dumps(rec.get("metadata", {}), ensure_ascii=False),
                    ),
                )
            except sqlite3.OperationalError:
                pass

            inserted += 1

        conn.commit()
    finally:
        conn.close()

    return inserted


def write_l2_scenes(data_dir: str, scenes: list[dict]) -> list[str]:
    scene_dir = Path(data_dir) / "scene_blocks"
    scene_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()

    written_files: list[str] = []
    for scene in scenes:
        filename = scene.get("filename", "").strip()
        if not filename:
            continue
        if not filename.endswith(".md"):
            filename += ".md"

        summary = scene.get("summary", "")
        content = scene.get("content", "")
        heat = scene.get("heat", 1)

        meta_block = "\n".join([
            "-----META-START-----",
            f"created: {now}",
            f"updated: {now}",
            f"summary: {summary}",
            f"heat: {heat}",
            "-----META-END-----",
        ])

        full_content = f"{meta_block}\n\n{content}"
        fpath = scene_dir / filename
        fpath.write_text(full_content, encoding="utf-8")
        written_files.append(filename)

    return written_files


def write_l3_persona(data_dir: str, persona_content: str) -> bool:
    if not persona_content.strip():
        return False
    persona_path = Path(data_dir) / "persona.md"
    persona_path.write_text(persona_content, encoding="utf-8")
    return True


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: write-results.py <data_dir> <intermediate_dir>", file=sys.stderr)
        return 64

    data_dir = sys.argv[1]
    intermediate_dir = sys.argv[2]
    session_key = os.environ.get("CONSOLIDATION_SESSION_KEY", "consolidation:manual")

    result = {"l1_jsonl": 0, "l1_sqlite": 0, "l2_scenes": 0, "l3_persona": False}

    merged_path = Path(intermediate_dir) / "merged-memories.json"
    if merged_path.exists():
        scenes_data = json.loads(merged_path.read_text("utf-8"))
        all_memories = []
        for scene in scenes_data:
            for mem in scene.get("memories", []):
                mem["scene_name"] = scene.get("scene_name", "")
                all_memories.append(mem)

        if all_memories:
            records = write_l1_jsonl(data_dir, all_memories, session_key)
            result["l1_jsonl"] = len(records)
            result["l1_sqlite"] = write_l1_sqlite(data_dir, records)

    scenes_path = Path(intermediate_dir) / "scenes.json"
    if scenes_path.exists():
        scenes_list = json.loads(scenes_path.read_text("utf-8"))
        if isinstance(scenes_list, list):
            written = write_l2_scenes(data_dir, scenes_list)
            result["l2_scenes"] = len(written)

    persona_path = Path(intermediate_dir) / "persona.md"
    if persona_path.exists():
        persona_content = persona_path.read_text("utf-8")
        result["l3_persona"] = write_l3_persona(data_dir, persona_content)

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Commit**

```bash
git add skills/memory-consolidation/write-results.py
git commit -m "feat: add write-results script for L1/L2/L3 persistence"
```

---

### Task 5: Scene Builder Agent

**Files:**
- Create: `agents/scene-builder.md`

- [ ] **Step 1: Create agents/scene-builder.md**

```markdown
---
name: scene-builder
description: Group L1 memory atoms into L2 scene blocks — thematic clusters of related memories. Dispatched by memory-consolidation skill during Phase 4. Reads merged memories and produces scene block definitions.
model: inherit
color: green
tools: ["Read", "Write"]
---

You are a scene organizer. Given a list of extracted L1 memory atoms (each with a scene_name from extraction), your job is to consolidate them into well-defined L2 scene blocks.

## Input

You will receive the path to `intermediate/merged-memories.json`. Read it. The file contains an array of scene objects, each with `scene_name`, `message_ids`, and `memories[]`.

## Task

1. Group memories by similar scene_name (fuzzy — merge scenes that are clearly about the same topic)
2. For each final scene, produce a markdown file definition with:
   - **filename**: kebab-case, e.g. `ide-configuration.md`
   - **summary**: one-sentence description
   - **content**: markdown body listing key facts from the memories in that scene
   - **heat**: number of memories in the scene (proxy for importance)

## Output

Write a JSON array to the output path given in your dispatch prompt:

```json
[
  {
    "filename": "ide-configuration.md",
    "summary": "User's IDE preferences and development environment setup",
    "content": "## Key Facts\n- User prefers dark mode\n- Uses VS Code primarily\n- Custom keybindings for navigation",
    "heat": 3
  }
]
```

Guidelines:
- Merge scenes that overlap (e.g. "Configuring VS Code" and "Setting up IDE" → one scene)
- Each scene should have at least 2 memories; single-memory scenes can be merged into a related scene
- Keep summaries concise (under 100 chars)
- Content should be a bulleted list of the key facts, not full prose
```

- [ ] **Step 2: Commit**

```bash
git add agents/scene-builder.md
git commit -m "feat: add scene-builder subagent for L2 scene blocks"
```

---

### Task 6: Persona Builder Agent

**Files:**
- Create: `agents/persona-builder.md`

- [ ] **Step 1: Create agents/persona-builder.md**

```markdown
---
name: persona-builder
description: Generate or update the L3 user persona from L1 atoms and L2 scenes. Dispatched by memory-consolidation skill during Phase 5. Produces a concise persona.md.
model: inherit
color: magenta
tools: ["Read", "Write"]
---

You are a persona synthesizer. Given L1 memory atoms and L2 scene blocks, generate a concise user persona document.

## Input

You will receive paths to:
- `intermediate/merged-memories.json` — all L1 atoms grouped by scene
- `intermediate/scenes.json` — L2 scene definitions (if exists)
- Existing `persona.md` — current persona (if exists; incorporate and update, don't discard)

Read these files.

## Task

Synthesize a `persona.md` that captures the user's stable profile. Structure:

```markdown
# User Persona

## Identity
- [Role, profession, background]

## Preferences
- [Stable preferences extracted from persona-type memories]

## Skills & Expertise
- [Technical skills, domain knowledge]

## Working Style
- [How they work, tools they use, communication preferences]

## Instructions for AI
- [Any instruction-type memories that are long-term rules]
```

## Guidelines

- Only include facts supported by L1 atoms (don't invent)
- Prioritize high-priority memories (priority >= 70)
- If an existing persona.md exists, merge new information — don't lose existing content unless contradicted by newer memories
- Keep each section to 3-7 bullet points max
- Write in third person ("User prefers..." not "You prefer...")

## Output

Write the persona markdown directly to the output path given in your dispatch prompt. Output ONLY the markdown content, no JSON wrapper.
```

- [ ] **Step 2: Commit**

```bash
git add agents/persona-builder.md
git commit -m "feat: add persona-builder subagent for L3 generation"
```

---

### Task 7: Memory Reviewer Agent

**Files:**
- Create: `agents/memory-reviewer.md`

- [ ] **Step 1: Create agents/memory-reviewer.md**

```markdown
---
name: memory-reviewer
description: Validate extracted L1/L2/L3 data for consistency, quality, and correctness before writing to the data directory. Dispatched by memory-consolidation skill during Phase 6.
model: inherit
color: red
tools: ["Read", "Write", "Bash"]
---

You are a memory quality reviewer. Validate the consolidated extraction results before they are written to persistent storage.

## Input

Read these files from the intermediate directory:
- `merged-memories.json` — L1 atoms
- `scenes.json` — L2 scene blocks
- `persona.md` — L3 persona

## Validation Checks

Run each check and record pass/fail with details:

### Check 1: L1 Schema Validation
- Every memory has `content` (non-empty string)
- Every memory has `type` ∈ {"persona", "episodic", "instruction"}
- Every memory has `priority` (number, -1 or 0-100)
- No duplicate content (exact match)

### Check 2: L1 Quality
- No memories that are just greetings or trivial chatter
- No memories describing AI behavior (should be about the user)
- Each memory is self-contained (doesn't reference "this conversation" or "above")
- Persona memories use pattern "User [verb]..."
- Instruction memories use pattern "User wants/requires AI..."

### Check 3: L2 Scene Validation
- Every scene has `filename` (valid filename, kebab-case)
- Every scene has `summary` (non-empty)
- Every scene has `content` (non-empty)
- No duplicate filenames

### Check 4: L3 Persona Validation
- persona.md is non-empty
- Contains at least one section header (##)
- Doesn't contain hallucinated facts (cross-check against L1 atoms)

## Output

Write a JSON object to the output path:

```json
{
  "status": "pass",
  "checks": [
    {"name": "l1_schema", "status": "pass", "issues": []},
    {"name": "l1_quality", "status": "pass", "issues": []},
    {"name": "l2_scenes", "status": "pass", "issues": []},
    {"name": "l3_persona", "status": "pass", "issues": []}
  ],
  "summary": "All checks passed. 15 memories, 4 scenes, persona valid."
}
```

If status is "fail", list specific issues. The orchestrator will decide whether to proceed or abort.
```

- [ ] **Step 2: Commit**

```bash
git add agents/memory-reviewer.md
git commit -m "feat: add memory-reviewer subagent for validation"
```

---

### Task 8: Consolidation Skill (Orchestrator)

**Files:**
- Create: `skills/memory-consolidation/SKILL.md`

The central orchestrator that drives the 7-phase pipeline.

- [ ] **Step 1: Create skills/memory-consolidation/SKILL.md**

```markdown
---
name: memory-consolidation
description: Extract and consolidate L1/L2/L3 memories from L0 raw conversations using this agent's own intelligence. No external LLM API needed. Use when the user says "consolidate memories", "extract memories", "update persona from conversations", "run memory pipeline", "process L0 conversations", or runs /memory-consolidate.
---

# Memory Consolidation Pipeline

Extract L1 atoms, L2 scene blocks, and L3 persona from L0 raw conversations. This pipeline uses the current agent as the extraction engine — no external LLM API keys required.

## Phase 0 — Pre-flight

1. Resolve the data directory:

```bash
DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
echo "Data directory: $DATA_DIR"
ls "$DATA_DIR/conversations/" 2>/dev/null | head -5 || echo "No conversations directory found"
```

If no conversations directory exists, tell the user to run `/memory-init` first and capture some conversations, then STOP.

2. Create the intermediate directory:

```bash
INTERMEDIATE="$DATA_DIR/intermediate"
mkdir -p "$INTERMEDIATE"
```

3. Read checkpoint (if exists) to find the last consolidation timestamp:

```bash
cat "$DATA_DIR/consolidation-checkpoint.json" 2>/dev/null || echo '{"last_consolidated_at": null}'
```

Store the `last_consolidated_at` value as `$SINCE` for Phase 1.

---

## Phase 1 — SCAN

Report: `[Phase 1/7] Scanning L0 conversations...`

Run the reader script to find unprocessed conversations:

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/consolidate_reader.py \
  --data-dir "$DATA_DIR" \
  ${SINCE:+--since "$SINCE"}
```

Read the output. If `total_messages` is 0, report "No new conversations to process" and STOP.

If `total_messages` > 200, inform the user this may take a while.

Store the output as `$SCAN_RESULT`. Write it to the intermediate directory:

```bash
cat > "$INTERMEDIATE/scan-result.json" << 'ENDJSON'
<paste scan result>
ENDJSON
```

---

## Phase 2 — EXTRACT (parallel batches)

Report: `[Phase 2/7] Extracting memories from conversations...`

Split conversations into batches of ~10-20 messages each. For each batch, dispatch a subagent using the `memory-extractor` agent definition.

Dispatch prompt template:

> Extract memories from these conversation messages.
> Output path: `$INTERMEDIATE/batch-<batchIndex>.json`
>
> Previous scene name: `<last scene name from previous batch, or "none">`
>
> Messages:
> ```
> [msg_id] [role] [timestamp]: content
> ```

Run up to 3 subagents concurrently for large datasets.

After ALL batches complete, report: `Phase 2 complete. <N> batches processed.`

---

## Phase 3 — MERGE + DEDUP

Report: `[Phase 3/7] Merging and deduplicating...`

```bash
python ${CLAUDE_PLUGIN_ROOT}/skills/memory-consolidation/merge-memories.py "$INTERMEDIATE"
```

Read the output summary. If 0 memories after merge, report "No meaningful memories extracted" and STOP.

---

## Phase 4 — SCENES

Report: `[Phase 4/7] Building scene blocks...`

Dispatch a subagent using the `scene-builder` agent definition:

> Build L2 scene blocks from the merged memories.
> Input: `$INTERMEDIATE/merged-memories.json`
> Output: `$INTERMEDIATE/scenes.json`

After the subagent completes, read `scenes.json` and report the count.

---

## Phase 5 — PERSONA

Report: `[Phase 5/7] Generating persona...`

Dispatch a subagent using the `persona-builder` agent definition:

> Generate the user persona from extracted memories and scenes.
> Memories: `$INTERMEDIATE/merged-memories.json`
> Scenes: `$INTERMEDIATE/scenes.json`
> Existing persona: `$DATA_DIR/persona.md` (if exists)
> Output: `$INTERMEDIATE/persona.md`

---

## Phase 6 — REVIEW

Report: `[Phase 6/7] Reviewing extraction quality...`

Dispatch a subagent using the `memory-reviewer` agent definition:

> Validate the consolidated extraction results.
> Intermediate directory: `$INTERMEDIATE`
> Output: `$INTERMEDIATE/review.json`

Read `review.json`. If status is "fail", report the issues to the user and ask whether to proceed or abort.

---

## Phase 7 — WRITE

Report: `[Phase 7/7] Writing results to data directory...`

```bash
python ${CLAUDE_PLUGIN_ROOT}/skills/memory-consolidation/write-results.py "$DATA_DIR" "$INTERMEDIATE"
```

Read the output and report:
- L1 memories written (JSONL + SQLite)
- L2 scene blocks written
- L3 persona updated

Update the consolidation checkpoint:

```bash
cat > "$DATA_DIR/consolidation-checkpoint.json" << 'ENDJSON'
{"last_consolidated_at": "<current ISO timestamp>", "memories_written": <count>}
ENDJSON
```

Report: **Consolidation complete.** Summarize what was written.

Suggest: "Run `/memory-search <query>` to test recall, or `/memory-persona` to view the updated persona."
```

- [ ] **Step 2: Commit**

```bash
git add skills/memory-consolidation/SKILL.md
git commit -m "feat: add memory-consolidation orchestrator skill (7-phase pipeline)"
```

---

### Task 9: Slash Command

**Files:**
- Create: `commands/memory-consolidate.md`

- [ ] **Step 1: Create commands/memory-consolidate.md**

```markdown
---
description: Extract and consolidate L1/L2/L3 memories from raw conversations using this agent's intelligence. No external LLM API needed.
---

Run the memory consolidation pipeline. This uses the current agent to extract structured memories (L1 atoms), scene blocks (L2), and user persona (L3) from captured L0 conversations.

Invoke the `memory-consolidation` skill to begin the 7-phase pipeline.
```

- [ ] **Step 2: Commit**

```bash
git add commands/memory-consolidate.md
git commit -m "feat: add /memory-consolidate slash command"
```

---

### Task 10: Final Integration Commit

- [ ] **Step 1: Verify all files exist**

```bash
ls -la scripts/consolidate_reader.py
ls -la agents/memory-extractor.md agents/scene-builder.md agents/persona-builder.md agents/memory-reviewer.md
ls -la skills/memory-consolidation/SKILL.md skills/memory-consolidation/merge-memories.py skills/memory-consolidation/write-results.py
ls -la commands/memory-consolidate.md
```

- [ ] **Step 2: Update README.md with new commands section**

Add to the "Slash commands" section in README.md:

```markdown
- `/memory-consolidate` - extract L1/L2/L3 from conversations using this agent (no LLM API needed)
```

Add to the "Agent" section:

```markdown
- `memory-extractor` - extracts L1 atoms from conversation batches
- `scene-builder` - groups memories into L2 scene blocks
- `persona-builder` - generates L3 persona from memories
- `memory-reviewer` - validates extraction quality
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README with self-consolidation feature"
```
