# Self-Consolidation Memory System — Full Goal Reference

> This is the uncompressed goal text for reference. The compressed version is used in `/goal`.

```
/goal Self-Consolidation Memory System: Agent-driven L1/L2/L3 extraction from native Claude Code conversation logs
  with zero paid services

  Context to read first:
  - D:\2026\tencentdb-agent-memory\ (current plugin repo)
  - D:\2026\tencentdb-agent-memory\docs\superpowers\specs\2025-05-25-self-consolidation-design.md (design spec, needs
  update)

  Source behavior reference (clone tại C:\Users\BaoDo\AppData\Local\Temp\TencentDB-Agent-Memory\):
  - src/core/prompts/l1-extraction.ts — L1 extraction prompt (scene segmentation + memory extraction, 3 types:
  persona/episodic/instruction, priority scoring, JSON output format)
  - src/core/prompts/l1-dedup.ts — L1 dedup prompt (conflict detection, store/update/merge/skip decisions)
  - src/core/prompts/scene-extraction.ts — L2 scene extraction prompt (LLM agent with tools, sandboxed to scene_blocks/)
  - src/core/prompts/persona-generation.ts — L3 persona generation prompt (four-layer deep scan)
  - src/core/record/l1-writer.ts — MemoryRecord schema (id, content, type, priority, scene_name, source_message_ids,
  metadata, timestamps, sessionKey)
  - src/core/record/l1-extractor.ts — L1 extraction pipeline (batch messages → LLM call → parse JSON → dedup → write)
  - src/core/record/l1-dedup.ts — Dedup logic (vector similarity → LLM conflict resolution)
  - src/core/record/l1-reader.ts — L1 read from JSONL + SQLite
  - src/core/scene/scene-format.ts — Scene block format (META header: created/updated/summary/heat + markdown body)
  - src/core/scene/scene-index.ts — Scene index management (scene_index.json)
  - src/core/scene/scene-navigation.ts — Scene navigation block generation
  - src/core/scene/scene-extractor.ts — L2 extraction flow (backup → load index → LLM agent → cleanup → sync index)
  - src/core/persona/persona-generator.ts — L3 generation flow (read existing → read scenes → LLM → write persona.md)
  - src/core/persona/persona-trigger.ts — L3 trigger logic (every N new L1 atoms)
  - src/core/hooks/auto-recall.ts — Recall flow (persona inject + L1 search + scene navigation + memory-tools guide)
  - src/core/hooks/auto-capture.ts — Capture flow (L0 recording + scheduler notify)
  - src/core/store/embedding.ts — Local embedding (embeddinggemma-300m via node-llama-cpp, fallback to keyword-only)
  - src/core/store/sqlite.ts — SQLite + sqlite-vec + FTS5 schema
  - src/core/store/types.ts — IMemoryStore interface, L0/L1 record types, search result types
  - src/gateway/server.ts — HTTP API endpoints (/health, /recall, /capture, /search/*, /session/end, /seed)
  - src/gateway/config.ts — Gateway config loading (tdai-gateway.yaml/json + env vars)
  - src/utils/pipeline-manager.ts — Pipeline scheduler (everyNConversations, warmup, idle timeout, L2/L3 triggers)
  - src/utils/checkpoint.ts — Checkpoint management (track what's been processed)

  Native Claude Code L0 format:
  - ~/.claude/projects/D--2026-tencentdb-agent-memory/*.jsonl
  - Entry types: user (message.content: string), assistant (message.content: [{type: "text", text: "..."}, {type:
  "tool_use", ...}])
  - Fields: type, message.role, message.content, uuid, timestamp (ISO8601), sessionId, parentUuid

  Plugin development skills (follow these for implementation):
  - plugin-dev:hook-development — Hook types (command/prompt/agent), hooks.json plugin format ({"hooks": {event: [...]}}
   wrapper), event-specific output schemas, matchers, environment variables ($CLAUDE_PLUGIN_ROOT, $CLAUDE_PROJECT_DIR),
  exit codes, async vs sync behavior, timeout defaults (command:600, prompt:30, agent:60), testing with claude --debug
  - plugin-dev:skill-development — SKILL.md structure (YAML frontmatter required: name + description in third-person
  with trigger phrases), progressive disclosure (SKILL.md < 2000 words, details in references/), imperative writing
  style, bundled resources (scripts/, references/, assets/), auto-discovery from skills/ directory
  - plugin-dev:command-development — Command .md structure (YAML frontmatter: description, allowed-tools), dynamic
  arguments, bash execution patterns, user interaction via AskUserQuestion
  - plugin-dev:plugin-structure — Plugin directory layout, plugin.json manifest, component organization,
  ${CLAUDE_PLUGIN_ROOT} usage, auto-discovery conventions

  Constraints:
  - Zero paid LLM or embedding services. Agent itself (Claude Code session) performs all extraction.
  - Python stdlib only (json, sqlite3, pathlib, http.server). No pip dependencies.
  - No upstream Gateway fork. All new code lives in this plugin repo.
  - No Node.js Gateway required for core memory functionality (keep existing Gateway integration as optional
  enhancement).
  - SessionEnd agent hook must NOT return output to main conversation context (agent hook returns {ok, reason} only).
  - Recall injection must be < 300 tokens per turn. Fail = silent skip.
  - Incremental processing by timestamp. Resumable after interruption.
  - Global memory (persona, global instructions) separated from project memory (episodic, project instructions).
  - Adapt upstream Chinese prompts to English/multilingual for broader agent compatibility.
  - Match upstream data formats where possible (MemoryRecord schema, scene block META format, JSONL sharding by date)
  for future interop with Gateway.

  Operating rules:
  - Keep progress log in docs/superpowers/specs/2025-05-25-self-consolidation-progress.md when the task is long-running.
  - Prefer small verified iterations over large unverified edits.
  - Do not expand scope without pausing.
  - Follow existing plugin patterns (hooks/scripts/_common.py, scripts/gateway_client.py).
  - Use plugin hook format: {"hooks": {"EventName": [...]}} wrapper in hooks/hooks.json.
  - Skills use imperative/infinitive form, third-person description per plugin-dev:skill-development.
  - Commands use YAML frontmatter with description + allowed-tools per plugin-dev:command-development.
  - Reference upstream behavior but simplify: no vector search (FTS5 only), no embedding, no LLM pipeline — agent
  replaces all LLM calls.

  Validation loop:
  - During work:
    - Each Python script runs standalone: `uv run python script.py --help`
    - SQLite FTS5 index creates and queries correctly
    - Hook JSON validates against Claude Code hook schema
    - SKILL.md has valid YAML frontmatter with name + description
    - Extracted L1 JSON matches upstream MemoryRecord schema fields
    - Scene blocks match upstream META format (-----META-START-----, created/updated/summary/heat, -----META-END-----)
  - Final proof:
    - SessionEnd agent hook: close a session → records/{date}.jsonl contains extracted L1 atoms
    - Recall: start new session → UserPromptSubmit hook injects <memory-context> with relevant memories
    - /memory-seed: run on existing ~/.claude/projects/ → processes old sessions incrementally
    - /memory-consolidate: run manually → L2 scene blocks created, L3 persona.md updated
    - Global vs project: persona atoms in ~/.memory-tencentdb/global/, episodic in ~/.memory-tencentdb/projects/{hash}/
    - state.json tracks last_consolidated timestamps per project, resumes correctly after interrupt

  Done when:
  - SessionEnd agent hook extracts L1 atoms automatically (invisible to user)
  - UserPromptSubmit command hook recalls and injects relevant memories (< 300 tokens, < 5s)
  - /memory-seed command backfills old conversation data incrementally by timestamp
  - /memory-consolidate command produces L2 scenes + L3 persona from accumulated L1 atoms
  - Global/project memory separation works with merged recall
  - state.json incremental timestamps work across all triggers
  - All existing plugin functionality (Gateway integration) still works unchanged
  - Design spec updated to reflect final implementation

  Pause if:
  - Claude Code hook "type: agent" on SessionEnd doesn't work as documented (test first)
  - SQLite FTS5 not available in Python's bundled sqlite3 on Windows
  - Native Claude Code JSONL format changes or has undocumented fields
  - Token budget for recall injection consistently exceeds 300 tokens
  - Agent hook timeout (60s default) insufficient for L1 extraction of typical session
  - Any existing plugin hooks break due to hooks.json format changes

  Storage layout:
    ~/.memory-tencentdb/
    ├── global/
    │   ├── records/*.jsonl              (L1: persona + global instructions)
    │   ├── persona.md                   (L3)
    │   └── index.db                     (SQLite FTS5)
    ├── projects/
    │   ├── {project-hash}/
    │   │   ├── records/*.jsonl          (L1: episodic + project instructions)
    │   │   ├── scene_blocks/*.md        (L2 with META header)
    │   │   └── index.db                 (SQLite FTS5)
    │   └── ...
    └── state.json                       (incremental timestamps)

  Components to build:
    1. scripts/memory_store.py           — SQLite FTS5 storage (read/write L1, search, mirrors upstream IMemoryStore
  interface simplified)
    2. scripts/memory_reader.py          — Read native Claude JSONL as L0 (parse user/assistant messages, extract text
  from content blocks)
    3. scripts/memory_writer.py          — Write L1/L2/L3 to storage layout (JSONL + FTS5 + scene blocks + persona)
    4. scripts/memory_recall.py          — FTS5 search + format <memory-context> (mirrors upstream auto-recall: persona
  + top-K L1 + scene nav)
    5. hooks/hooks.json                  — Add SessionEnd agent hook (merge with existing hooks)
    6. hooks/scripts/on_session_end.py   — Update to support both Gateway capture + local L1 extraction
    7. commands/memory-consolidate.md    — Manual L2 + L3 consolidation
    8. commands/memory-seed.md           — Backfill old conversations incrementally by timestamp
    9. skills/memory-consolidation/SKILL.md — Extraction skill (adapted from upstream l1-extraction.ts prompt)
    10. skills/memory-consolidation/references/extraction-guide.md — Detailed L1/L2/L3 format, examples, scope
  classification rules

  Why this goal is safe to run:
  - Success condition: Verifiable via file existence checks (records/*.jsonl, persona.md, index.db) and recall injection
   test
  - Main risk: SessionEnd agent hook might not support type: "agent" or timeout may be too short — mitigated by "Pause
  if" rule requiring early test
  - Proof artifacts: state.json timestamps, records/*.jsonl content, claude --debug hook logs, /memory-status output
  - Upstream compatibility: L1 MemoryRecord schema and L2 scene META format match upstream, enabling future Gateway
  interop without migration
```

## Hints for Next Session

### Compressed Goal (paste into `/goal`, 2857 chars)

```
Self-Consolidation Memory: Agent-driven L1/L2/L3 extraction from Claude Code JSONL logs, zero paid services.

Context: D:\2026\tencentdb-agent-memory\ (plugin repo), docs/superpowers/specs/2025-05-25-self-consolidation-design.md (design spec).
Upstream ref (C:\Users\BaoDo\AppData\Local\Temp\TencentDB-Agent-Memory\):
- Prompts: l1-extraction.ts (3 types: persona/episodic/instruction, priority, JSON), l1-dedup.ts (store/update/merge/skip), scene-extraction.ts (LLM agent+tools), persona-generation.ts (four-layer scan)
- Records: l1-writer.ts (MemoryRecord schema), l1-extractor.ts (batch→LLM→parse→dedup→write), l1-dedup.ts (vector sim→LLM), l1-reader.ts (JSONL+SQLite)
- Scenes: scene-format.ts (META header), scene-index.ts, scene-navigation.ts, scene-extractor.ts (backup→index→LLM→sync)
- Persona: persona-generator.ts, persona-trigger.ts (every N atoms)
- Hooks: auto-recall.ts (persona+L1 search+scene nav), auto-capture.ts (L0+scheduler)
- Store: embedding.ts (local gemma-300m), sqlite.ts (sqlite-vec+FTS5), types.ts (IMemoryStore)
- Gateway: server.ts (HTTP API), config.ts; Pipeline: pipeline-manager.ts, checkpoint.ts

L0 format: ~/.claude/projects/{hash}/*.jsonl. Fields: type, message.role/content, uuid, timestamp, sessionId, parentUuid. User=string content, assistant=[{type:"text"/"tool_use",...}].

Follow plugin-dev skills: hook-development, skill-development, command-development, plugin-structure.

Constraints: Zero paid LLM/embedding—agent does extraction. Python stdlib only. No Gateway fork. SessionEnd agent hook returns {ok,reason} only. Recall <300 tokens, <5s. Incremental by timestamp, resumable. Global(persona,instructions) vs project(episodic,project-instructions) separation. English prompts. Match upstream formats for interop.

Rules: Progress log in docs/superpowers/specs/2025-05-25-self-consolidation-progress.md. Small verified iterations. No scope creep. Follow existing patterns (hooks/scripts/_common.py). Plugin hook format: {"hooks":{"Event":[...]}}. No vector search—FTS5 only, agent replaces LLM calls.

Validation: Scripts run standalone (uv run python script.py --help). FTS5 works. Hook JSON valid. SKILL.md frontmatter valid. L1 matches MemoryRecord schema. Scenes match META format.
Final: SessionEnd→records/{date}.jsonl. New session→<memory-context> injected. /memory-seed processes old sessions. /memory-consolidate→L2 scenes+L3 persona. Global/project separation. state.json resumes correctly.

Done: SessionEnd extracts L1 (invisible). UserPromptSubmit recalls (<300tok,<5s). /memory-seed backfills incrementally. /memory-consolidate produces L2+L3. Global/project merged recall. state.json works. Existing Gateway integration unchanged. Design spec updated.

Pause if: agent hook type:agent fails, FTS5 unavailable on Windows, JSONL format changes, recall >300 tokens, agent timeout <60s insufficient, existing hooks break.

Storage: ~/.memory-tencentdb/{global/{records/*.jsonl,persona.md,index.db}, projects/{hash}/{records/*.jsonl,scene_blocks/*.md,index.db}, state.json}

Components: 1.scripts/memory_store.py (FTS5 storage) 2.scripts/memory_reader.py (read L0 JSONL) 3.scripts/memory_writer.py (write L1/L2/L3) 4.scripts/memory_recall.py (FTS5 search+format) 5.hooks/hooks.json (add SessionEnd agent) 6.hooks/scripts/on_session_end.py (Gateway+local L1) 7.commands/memory-consolidate.md 8.commands/memory-seed.md 9.skills/memory-consolidation/SKILL.md 10.skills/memory-consolidation/references/extraction-guide.md

Safety: Verifiable via file checks+recall test. Risk mitigated by early agent hook test. Upstream-compatible schemas.
```

### Quick Start Hints

1. **Read design spec first**: `docs/superpowers/specs/2025-05-25-self-consolidation-design.md`
2. **Check progress log**: `docs/superpowers/specs/2025-05-25-self-consolidation-progress.md`
3. **Upstream source is at**: `C:\Users\BaoDo\AppData\Local\Temp\TencentDB-Agent-Memory\`
4. **Start with**: Test FTS5 availability → build memory_store.py → memory_reader.py → iterate
5. **Key architectural decision**: Agent (Claude Code session) replaces all LLM calls from upstream. No separate LLM service needed.
6. **Plugin dev skills to invoke**: `plugin-dev:hook-development`, `plugin-dev:skill-development`, `plugin-dev:command-development`
