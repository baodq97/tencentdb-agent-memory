---
name: contrib-consolidate
description: Consolidate a contributor's L1 atoms into an L3 persona across 11 dimensions. Triggers when the user says "build contributor persona", "consolidate <user>", or after contrib-ingest completes. This ORGANIZES existing atoms — for creating atoms use contrib-ingest.
---

# Contributor Consolidate

Group one subject's L1 atoms into themes (L2 scenes, conceptual) and write a
single L3 persona summarising all 11 dimensions with evidence.

## Workflow

### 1. Read the atoms

```bash
tmem contrib atoms <subject-id>
```

### 2. Build the persona

For each of the 11 dimensions (`idea, plan, solve, craft, comms, mentor,
conflict, scope, ownership, execution`), synthesise the atoms in that dimension
into 1–3 sentences. Carry the strongest evidence links into the text. If a
dimension has no atoms, set it to `"insufficient data"`.

Collect 3–6 `notable_traits` — distinctive things that don't fit a fixed
dimension (e.g. "writes prose-quality commit bodies", "prefers small composable
modules").

### 3. Write the persona

```bash
tmem contrib upsert-persona --json '{
  "subject_id": "<id>",
  "summary": "<2-3 sentence overview of how this engineer works>",
  "dimensions": {
    "idea": "...", "plan": "...", "solve": "...", "craft": "...",
    "comms": "...", "mentor": "...", "conflict": "...",
    "scope": "...", "ownership": "...", "execution": "..."
  },
  "notable_traits": ["...", "..."],
  "updated_time": "<ISO timestamp>"
}'
```

### 4. Report

Print the persona (`tmem contrib persona <id>`) and tell the user which
dimensions are well-evidenced vs "insufficient data".
