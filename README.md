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
tmem search <query>             FTS5 keyword search (global + current project)
tmem search <query> --all       Cross-project: search every project store, labelled by store
tmem projects                   List all memory stores (slug, records, scenes)
tmem migrate-fragments [--apply]  Collapse legacy cwd-keyed fragment stores into their project root
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

**Prerequisite:** an authenticated `gh` CLI (`gh auth login`). All data lives in
`<global>/contributors/` — the self-memory feature is never touched.

### Quickest way — just drop a link

Paste a GitHub link (or a handle) and say what you want — the **contrib-profile**
skill takes it A→Z for you:

> "Analyze how this engineer works: https://github.com/sindresorhus/ky"
> "Profile https://github.com/torvalds and show me the playbook"

It resolves the target (picks the right repo if you only give a user), runs the
whole pipeline, and hands back the persona + learnable playbook. Prefer to drive
it yourself? Ask "how do I use /contrib" and it guides you through the steps
below instead.

### Usage — first run (manual)

1. **Declare a subject** (a GitHub user in one repo):
   ```
   /contrib add <user> <owner/repo>
   ```
2. **Ingest** their public activity — `gh` fetches their PRs, commits (all
   branches), review threads and issues, then the agent classifies it into
   evidence-linked atoms across the 11 dimensions. Incremental by default
   (`--full` to refetch):
   ```
   /contrib ingest <user>@<repo>
   ```
3. **Build the persona** — consolidate the atoms into one profile:
   ```
   /contrib build <user>@<repo>
   ```
4. **Learn from it:**
   ```
   /contrib persona  <user>@<repo>    # the full dossier (11 dimensions + evidence)
   /contrib playbook <user>@<repo>    # emulable heuristics you can copy
   /contrib compare  <user>@<repo>    # you (your existing self-persona) vs this role model
   ```

### Going further

- **Capability model** — add a 2nd engineer and see what the top engineers
  *share* (needs ≥2 built personas; they don't have to include you):
  ```
  /contrib add <user2> <org2/repo2> ; /contrib ingest <user2>@<repo2> ; /contrib build <user2>@<repo2>
  /contrib capabilities
  ```
- **Two-engineer table** — `/contrib compare <a> <b>` (per-dimension, side by side).
- **Trajectory** — `/contrib trajectory <id>` (per-year cadence + commit-style arc).
- **Team** — `/contrib team add <teamId> <id...>` then `/contrib team capabilities <teamId>`.
- **Recall** — `/contrib search "<query>"` (keyword; vector too if the embed daemon
  is warm — run `/contrib sync` once to index).

### The 11 dimensions

Activity is classified into 11 dimensions across 3 clusters — Technical Craft
(`idea/plan/solve/craft`), Collaboration & Influence (`comms/mentor/conflict`),
and Outcomes & Ownership (`scope/ownership/execution`). Every atom and persona
claim is evidence-linked to a PR or commit. `v0.3.0` measures cadence/style, not
PR diff size (the GitHub search API omits it).

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
