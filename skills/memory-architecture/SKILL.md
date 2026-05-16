---
name: memory-architecture
description: Explains the TencentDB-Agent-Memory four-layer pyramid (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) and the Mermaid-canvas Context Offload short-term system. Use when the user asks how memory is structured, what L0/L1/L2/L3 mean, where persona.md / scene blocks / vectors.db live, how recall drills down from a Persona answer back to the source conversation, or what gets injected into each turn.
---

# Memory architecture

The plugin wraps the upstream **TencentDB-Agent-Memory** Gateway. The Gateway organises everything around two ideas: **layered memory** and **symbolic short-term memory**.

## Layered long-term memory (L0 → L3)

A semantic pyramid, narrow at the top:

| Layer | What | Storage | Purpose |
|------|------|---------|---------|
| **L0 Conversation** | Raw turns (user + assistant) | SQLite + JSONL under `conversations/` | Ground-truth evidence. Never compressed irreversibly. |
| **L1 Atom** | Atomic facts extracted by LLM | SQLite rows + vector index | Per-fact recall; the unit returned by `tdai_memory_search`. |
| **L2 Scenario** | Aggregated themes ("Project X work", "Cooking preferences") | Markdown files under `scene_blocks/` | Mid-level navigation for the agent. |
| **L3 Persona** | Top-level user profile | `persona.md` | Day-to-day preference summary, injected on every turn. |

**Drill-down rule.** Upper layers carry judgment; lower layers carry evidence. Every L3 sentence traces back to L2 scenes; every L2 scene traces to L1 atoms (`result_ref`); every atom traces to L0 messages.

When recall is wrong, walk the chain top-down — the `memory-debugger` agent automates this.

## What flows into each turn

When `UserPromptSubmit` fires, the plugin POSTs to the Gateway `/recall` endpoint. The response is injected into the user's prompt as `<memory-context>...</memory-context>` and typically contains:

- **L3 persona block** (stable, cacheable, appended to system context)
- **L2 scene navigation** (the index of scene blocks the agent can `read_file` into on demand)
- **L1 recalled memories** (top-K, hybrid BM25+vector RRF, dynamic per turn)
- **Memory-tools guide** (a few lines telling the model to call `tdai_memory_search` / `tdai_conversation_search` if context is thin — capped at 3 calls per turn)

## Symbolic short-term memory (Context Offload)

Off by default. When enabled (`offload.enabled: true`), verbose tool logs are written to `refs/*.md` and only a compact **Mermaid canvas** stays in context:

```
Verbose tool logs (100k+ tokens)
   |-- offload full text --> refs/<id>.md
   `-- extract relations --> Mermaid canvas (with node_id)
                                |
                                v light inject
                            Agent context (few hundred tokens)
                            recall via node_id --> refs/<id>.md
```

Triggers (see `memory-offload` skill for tuning):

- `mildOffloadRatio` (default 0.5) — start when context fills past 50% of the window
- `aggressiveCompressRatio` (default 0.85) — heavier compression past 85%
- `mmdMaxTokenRatio` (default 0.2) — Mermaid canvas itself capped at 20% of budget

## Where everything lives on disk

```
~/.memory-tencentdb/memory-tdai/        # default; override with TDAI_DATA_DIR
├── conversations/                       # L0 raw turns (JSONL + SQLite blobs)
├── records/                             # L1 atom export per session
├── scene_blocks/                        # L2 *.md
├── persona.md                           # L3
├── vectors.db                           # SQLite + sqlite-vec index
└── (offload only) refs/, *.mmd
```

When debugging, this directory is the source of truth — open the files directly.

## Recall strategies

`recall.strategy` chooses how L1 atoms are ranked:

- `keyword` — FTS5 BM25 only (no embedding required)
- `embedding` — pure vector cosine similarity (needs configured embedding provider)
- `hybrid` (default, recommended) — both lists merged via Reciprocal Rank Fusion (RRF, `k=60`)

If the embedding 4-tuple (`provider/baseUrl/apiKey/model/dimensions`) isn't configured, `hybrid` degrades silently to `keyword`.

## How this maps to Claude Code

- `UserPromptSubmit` hook → `/recall` → `additionalContext` is the entire `<memory-context>` block.
- `Stop` hook → `/capture` → records the just-finished turn into L0; the Gateway's pipeline scheduler decides when to run L1/L2/L3 next.
- `SessionEnd` hook → `/session/end` flushes anything pending.

Tool-side, the Gateway also exposes `tdai_memory_search` and `tdai_conversation_search`; from Claude Code these are reachable via the `/memory-search` and `/memory-conversation-search` slash commands, or by invoking them through an MCP server (optional, not enabled in v0.1).
