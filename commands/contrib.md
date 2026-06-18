---
description: Profile how top GitHub contributors work — ingest, build personas, and synthesise a capability model + learnable playbook.
---

# /contrib

Contributor intelligence. Subjects are declared in
`<global>/contributors/subjects.json`; all data lives in
`<global>/contributors/index.db` (never the self-memory DB).

## Subcommands

- `/contrib add <github_user> <owner/repo>` — add a subject.
- `/contrib ingest [id]` — fetch raw activity and extract 11-dimension atoms
  (invokes the **contrib-ingest** skill). Omit id to ingest all subjects.
  Incremental by default (only activity since the last sync); pass `--full` to
  refetch everything.
- `/contrib build [id]` — consolidate atoms into a persona (invokes
  **contrib-consolidate**).
- `/contrib persona <id>` — print a subject's dossier.
- `/contrib playbook <id>` — print the learnable playbook (invokes
  **contrib-synthesize**).
- `/contrib compare <id>` — you vs a role model: a qualitative gap analysis of
  the role model against your *existing* self-persona (`tmem persona`, built from
  your own history) — no need to ingest yourself from GitHub.
- `/contrib compare <id-a> <id-b>` — deterministic per-dimension table between two
  *profiled contributors* (peer/team).
- `/contrib capabilities` — print the L4 capability model.
- `/contrib sync [id]` — embed atoms into the contributor vector index (FTS works
  without this; vector recall needs it + the embed daemon).
- `/contrib search <query> [--subject <id>]` — keyword + vector recall over
  atoms (FTS-only if the embed daemon is down).
- `/contrib trajectory <id>` — per-year cadence + commit-style evolution arc
  (measures cadence/style, not PR LOC).
- `/contrib team add <teamId> <id...>` · `/contrib team capabilities <teamId>` —
  group subjects and synthesise a team-level capability model.

## Notes

- Requires an authenticated `gh` CLI. If missing, run `gh auth login`.
- Needs ≥2 subjects with personas before `capabilities`/L4 is meaningful (e.g. two
  role models — you don't have to be one of them).
- "You vs role model" reuses your *existing* self-persona (`tmem persona`, built
  from your own history) — you don't ingest your own GitHub.

Routing: subcommands that need judgment map to a skill — `ingest`/`build` →
contrib-ingest/contrib-consolidate; `playbook`, `compare <id>` (single, you-vs-
role-model), and the L4 narration of `capabilities` → contrib-synthesize. The
deterministic subcommands — `add`, `persona`, `capabilities` (raw numbers),
`compare <a> <b>` (two-contributor table), `trajectory`, `team`, `search` — call
the matching `tmem contrib …` CLI directly.
