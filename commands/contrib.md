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
- `/contrib build [id]` — consolidate atoms into a persona (invokes
  **contrib-consolidate**).
- `/contrib persona <id>` — print a subject's dossier.
- `/contrib playbook <id>` — print the learnable playbook (invokes
  **contrib-synthesize**).
- `/contrib compare <id-a> <id-b>` — per-dimension you-vs-role-model diff.
- `/contrib capabilities` — print the L4 capability model.

## Notes

- Requires an authenticated `gh` CLI. If missing, run `gh auth login`.
- Needs ≥2 subjects with personas before `capabilities`/L4 is meaningful.
- To use "you vs role model", add yourself as a subject too
  (`/contrib add <you> <your/repo>`).

When the user runs a subcommand that maps to a skill (ingest/build/playbook),
invoke that skill. For `add`/`persona`/`capabilities`/`compare`, call the
matching `tmem contrib …` CLI command directly.
