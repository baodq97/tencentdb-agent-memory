# tencentdb-agent-memory (Claude Code plugin)

Four-layer long-term memory (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) for Claude Code, inspired by [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

Fully local — no external Gateway, no paid API, no Python. All extraction and consolidation is done by the Claude agent itself.

## Installation

```bash
# Add marketplace
claude plugin marketplace add https://github.com/baodq97/tencentdb-agent-memory

# Install plugin
claude plugin install tencentdb-agent-memory
```

## Quick start

```bash
# Inside Claude Code:
/memory-init
# → installs deps, links tmem CLI, creates store
# → hints: "ask me to seed memories"
# then say "seed memories" → agent extracts L1 atoms
# then say "consolidate memories" → agent builds scenes + persona
# done — hybrid recall is now active automatically
```

## What happens automatically

| Hook | Action |
|------|--------|
| `UserPromptSubmit` | Hybrid recall (FTS5 + vector + RRF) + L2 scene-navigation index → inject `<memory-context>` |
| `Stop` | Auto-capture turn + background consolidation after N turns |
| `SessionEnd` | Mark session as pending for later seeding |

Hooks never block — failures degrade to no injection.

## How recall works

Each turn, the `UserPromptSubmit` hook builds a `<memory-context>` block from three layers:

1. **L3 persona** — a short summary of who you are / your standing preferences.
2. **L1 atoms** — hybrid search (FTS5 keyword + EmbeddingGemma vector, merged via RRF) over the most relevant memories, within a token budget.
3. **L2 scene-navigation** — a heat-ranked *index* of scene blocks (name + heat + summary), project scenes first then global, with its own token budget. Full scene content is **not** inlined; load it on demand with `tmem scene <name>` (progressive disclosure — cheap always-on index, full read only when needed).

Tune the scene-navigation budget with `tmem config scene-max-tokens N` (`0` disables it).

## Components

| Type | Name | Purpose |
|------|------|---------|
| Command | `/memory-init` | Install deps, link tmem CLI, init store |
| Skill | `memory-seed` | Agent extracts L1 atoms from conversation history |
| Skill | `memory-consolidate` | Agent builds L2 scenes + L3 persona |
| Skill | `tmem-cli` | CLI reference for memory inspection/management |
| Agent | `memory-consolidator` | Background worker dispatched by asyncRewake |

## tmem CLI

Installed automatically by `/memory-init`. Available in terminal and used by skills.

```
tmem status                     Memory stats
tmem search <query>             FTS5 keyword search
tmem recall <query>             Hybrid recall (FTS5 + vector + RRF) + L2 scene-navigation
tmem persona                    Show persona
tmem scenes list                List scene blocks
tmem scene <name>               Print one full scene block (project-first, then global)
tmem scenes dedup [--dry-run]   Remove duplicate scenes
tmem changelog [--last N]       Recent memory changes
tmem sync [--full]              Embed missing vectors (delta); --full rebuilds
tmem atoms [global|project|all] Dump L1 atoms as JSON
tmem sessions                   List pending sessions
tmem init                       Initialize memory store
tmem mark-done                  Mark consolidation complete
tmem config consolidate-every N Set consolidation threshold (default 20)
tmem config scene-max-tokens N  Set L2 scene-navigation token budget (default 200, 0 disables)
tmem daemon start               Warm + serve the embed daemon (foreground, like `ollama serve`)
tmem daemon status              Health-ping the daemon (ready/warming/failed/down + pid)
tmem daemon stop                Stop the daemon + clear its pidfile
```

## Contributor intelligence (`/contrib`)

Profile how a top GitHub engineer works — and learn from them.

```bash
/contrib add <user> <owner/repo>             # declare a subject
/contrib ingest <user>@<repo>                # gh -> 11-dimension atoms
/contrib build  <user>@<repo>                # atoms -> persona
/contrib playbook <user>@<repo>              # emulable heuristics
/contrib compare <user>@<repo>               # you (your existing self-persona) vs this role model
/contrib add <user2> <org2/repo2>            # add a 2nd engineer
/contrib ingest <user2>@<repo2> ; /contrib build <user2>@<repo2>
/contrib capabilities                        # L4: what these top SWEs share (>=2 subjects)
```

Activity is classified into 11 dimensions across 3 clusters — Technical Craft
(`idea/plan/solve/craft`), Collaboration & Influence (`comms/mentor/conflict`),
and Outcomes & Ownership (`scope/ownership/execution`). Stored separately under
`<global>/contributors/` — the self-memory feature is never touched. Requires an
authenticated `gh` CLI.

## Architecture

```
~/.memory-tencentdb/
├── global/           index.db (FTS5) + vectors.db (sqlite-vec) + persona.md + scenes/
├── projects/{hash}/  index.db + vectors.db + scenes/
└── models/           embeddinggemma-300m (~80MB, downloaded on first init)
```

## Tech stack

- **FTS5** — keyword search via `node:sqlite` (built-in)
- **sqlite-vec** — vector cosine search (npm)
- **EmbeddingGemma-300m** — local embedding via `node-llama-cpp` (npm, ~80MB model)
- **Resident embed daemon** — keeps the model warm over local IPC (named pipe / unix socket); degrades to FTS-only on failure. Manage explicitly with `tmem daemon start|status|stop`
- **RRF** (k=60) — merges FTS5 + vector results

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for per-version history.

## License

Plugin: MIT. Upstream inspiration: MIT (c) TencentDB Agent Memory Team.
