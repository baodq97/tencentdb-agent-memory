# tencentdb-agent-memory (Claude Code plugin)

[![npm version](https://img.shields.io/npm/v/@baodq97/tmem)](https://www.npmjs.com/package/@baodq97/tmem)
[![npm downloads](https://img.shields.io/npm/dm/@baodq97/tmem)](https://www.npmjs.com/package/@baodq97/tmem)
[![node](https://img.shields.io/node/v/@baodq97/tmem)](https://www.npmjs.com/package/@baodq97/tmem)

Four-layer long-term memory (L0 Conversation → L1 Atom → L2 Scene → L3 Persona) for Claude Code, inspired by [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

Fully local — no external Gateway, no paid API, no Python. All extraction and consolidation is done by the Claude agent itself.

## Installation

```bash
# Add marketplace
claude plugin marketplace add https://github.com/baodq97/tencentdb-agent-memory

# Install plugin
claude plugin install tencentdb-agent-memory
```

### Standalone CLI (npm)

The `tmem` CLI is also published on npm, CLI-only (no plugin assets), for use
outside Claude Code:

```bash
npx @baodq97/tmem <command>     # run once, no install
npm i -g @baodq97/tmem          # or install globally → `tmem`
tmem version                    # resolved version + path + node
tmem update                     # check npm for a newer release (--apply to install)
```

Requires Node ≥ 24 (`node:sqlite` `DatabaseSync` is flag-free from 24). The
embedding model (~314 MB, EmbeddingGemma-300M GGUF) downloads on first embed use
into `~/.memory-tencentdb/models/`, not at install.

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
| `SessionStart` | Inject the tier-0 persona core once per session (`<persona-core>`) + keep the global `tmem` shim current |
| `UserPromptSubmit` | Hybrid recall (FTS5 + vector + RRF) + L2 scene-navigation index → inject `<memory-context>` |
| `Stop` | Auto-capture turn + background consolidation after N turns |
| `SessionEnd` | Mark session as pending for later seeding |

Hooks never block — failures degrade to no injection.

## How recall works

Each turn, the `UserPromptSubmit` hook builds a `<memory-context>` block from three layers:

1. **L3 persona** — the `conditional` persona bullets this prompt actually reaches for, plus a short always-on insurance line (see [How the persona reaches the agent](#how-the-persona-reaches-the-agent)).
2. **L1 atoms** — hybrid search (FTS5 keyword + EmbeddingGemma vector, merged via RRF) over the most relevant memories, within a token budget.
3. **L2 scene-navigation** — a heat-ranked *index* of scene blocks (name + heat + summary), project scenes first then global, with its own token budget. Full scene content is **not** inlined; load it on demand with `tmem scene <name>` (progressive disclosure — cheap always-on index, full read only when needed).

Tune the scene-navigation budget with `tmem config scene-max-tokens N` (`0` disables it).

## How the persona reaches the agent

A consolidated persona grows well past what any per-turn budget can carry (~39k chars here). Rather than truncate it, each bullet is classified by **duty** and delivered on the channel that duty needs:

| Duty | Tier | Channel | Budget |
|------|------|---------|--------|
| `always` | 0 | `SessionStart` hook → `<persona-core>`, once per session | `persona-max-tokens` (default 1200) |
| `conditional` | 1 | `UserPromptSubmit` recall → `<persona>`, query-matched per turn | ~105 tokens |
| `reference` | 2 | on demand — `tmem persona --section <name>` | none (never injected) |

Tier 0 is paid **once per session**, not per turn, which is what makes a budget that size affordable. The tier-0 block also carries a one-line index of *every* section name — including sections it delivered nothing from — so the tier-2 pointer is something the agent can actually act on.

**Tier 0 delivers a bullet whole or not at all** — bullets over 600 chars are skipped, never truncated. A rule cut before its exceptions reads as a *different, stricter rule*, which is worse than its absence. Tier 1 still truncates, deliberately: tier 1 is cover, tier 0 is contract. Write persona bullets one rule at a time, operative clause first.

Inspect the split with `tmem persona --sections`; tune tier 0 with `tmem config persona-max-tokens N` (`0` is rejected — trimming is fine, switching persona conditioning off silently is not).

**This does not fully solve persona delivery.** On a 39k-char / 81-bullet persona, tier 0 delivers 13 of the 47 `always`-duty bullets — the `always` class alone is ~22k source chars against a 4,800-char budget, and 11 of those bullets are over the 600-char eligibility threshold. Closing that needs a synthesised core section on the consolidator side, which is not built yet.

## Memory visualiser (`tmem view`)

```bash
tmem view                      # start a session-keyed localhost server, print the URL
tmem view --query "<q>"        # preselect the Context lens with a recall query
tmem view --snapshot           # export the payload JSON once and exit (before/after measurement)
```

A read-only lens on the store, answering *"does the agent actually know me?"* — which persona bullets reach the agent, on which tier, and what the store's health gaps are. It opens every database with `DatabaseSync(..., { readOnly: true })`, so "never writes" is enforced by SQLite rather than by discipline.

The URL carries a per-session key and is required verbatim: the page renders raw captured prompts from every project, so `localhost` alone is not the boundary. Session output goes to `<root>/view/`, never inside a repo. Use `--static` to pin the numbers while you read them.

## Components

| Type | Name | Purpose |
|------|------|---------|
| Command | `/memory-init` | Install deps, link tmem CLI, init store |
| Command | `/contrib` | Contributor intelligence (see below) |
| Skill | `memory-seed` | Agent extracts L1 atoms from conversation history |
| Skill | `memory-consolidate` | Agent builds L2 scenes + L3 persona |
| Skill | `memory-view` | Opens the `tmem view` visualiser and reads the feedback back |
| Skill | `tmem-cli` | CLI reference for memory inspection/management |
| Skill | `contrib-profile` | Orchestrates the `/contrib` pipeline end to end |
| Skill | `contrib-ingest` / `contrib-consolidate` / `contrib-synthesize` | Internal `/contrib` phases (not user-invocable) |
| Agent | `memory-consolidator` | Background worker dispatched by asyncRewake |
| Module | `scripts/persona_projection.js` | Pure persona duty classification + tier 0/1 projection; shared by the hook, the CLI and the visualiser |
| Module | `scripts/scene_nav.js` | Pure `<scene-navigation>` renderer + budget arithmetic; shared by recall and the visualiser |

The two `Module` rows are shared **pure** cores (no `require`, no I/O). They exist because recall and the visualiser must agree on the same arithmetic, and the visualiser cannot import the recall path — doing so would pull `node:sqlite` into a layer whose contract is that it does no I/O (a test enforces it). One renderer, one projection, two callers.

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
tmem persona --sections         List persona sections (bullets + always/conditional/reference split)
tmem persona --section <name>   Print one persona section on demand (tier 2)
tmem view [--query <q>]         Open the memory visualiser (session-keyed localhost server)
tmem view --snapshot [--stdout] Export the visualiser payload JSON once and exit
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
tmem config persona-max-tokens N  Set the tier-0 persona budget (default 1200; 0 rejected)
tmem config recall [on|off]     Toggle per-turn recall injection for this project
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
├── global/           index.db (FTS5) + vectors.db (sqlite-vec) + persona.md
│   ├── records/      raw L1 atoms, one JSONL per day
│   ├── scene_blocks/ L2 scene markdown
│   └── contributors/ /contrib store (isolated from self-memory)
├── projects/{hash}/  index.db + vectors.db + records/ + scene_blocks/
├── view/             `tmem view` session + snapshot output (never inside a repo)
├── config.json       consolidate-every, scene-max-tokens, persona-max-tokens, per-project recall
└── models/           embeddinggemma-300m (~80MB, downloaded on first init)
```

### Bounded contexts (ubiquitous language)

The domain is a **memory pipeline** over four layers — **Transcript** (L0) →
**Atom** (L1) → **Scene** (L2) → **Persona/Doctrine** (L3) — worked by four verbs.
CLI commands (`tmem --help`) and modules are grouped by the stage they serve:

| Stage | Does | Key modules |
|-------|------|-------------|
| **Capture** | Transcript → Atoms (deterministic digest of tool blocks; hook auto-capture) | `session_digest`, `digest_capture`, `memory_auto_capture`, `grounding` |
| **Consolidate** | Atoms → Scenes + Persona (distil the "why"; dispatched by the pipeline) | `memory_pipeline`, memory-seed / memory-consolidate skills |
| **Recall** | Read memory for a turn (hybrid FTS+vector, scene-nav, persona projection) | `memory_recall`, `scene_nav`, `persona_projection`, `recall_feedback` |
| **Maintain** | Keep the store healthy — reachability, capture signal, recall feedback, cross-store | `doctor`, `memory_reachability`, `cross_store`, `memory_init` |
| _Storage_ | FTS5 + vector engines under all stages | `memory_store`, `memory_writer`, `memory_reader`, `vector_store`, `embed_*` |
| _Contrib_ | Contributor intelligence (separate sub-domain) | `contrib_*` |

**Invariants worth naming:** an atom's `type` decides its lane — `isVectorEligible`
(one source of truth) governs both what gets embedded and what recall keeps, so a
dead vector can never be written. Digest atoms are keyed by `(session, slot)` so
re-capture is idempotent. `doctor` is the front door to Maintain; the other
maintenance verbs are its detail.

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
