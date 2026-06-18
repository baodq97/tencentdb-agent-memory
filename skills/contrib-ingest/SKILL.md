---
name: contrib-ingest
description: Extract L1 contributor atoms from a GitHub subject's raw activity. Triggers after "tmem contrib raw <id>" or when the user says "ingest contributor", "profile <user>", "analyze how <user> works". This CREATES atoms from raw GitHub events — for synthesis use contrib-synthesize.
---

# Contributor Ingest

Turn one subject's raw GitHub activity into evidence-linked L1 atoms across the
11 fixed dimensions. You do all classification — no external LLM.

## Workflow

### 1. Fetch raw events

```bash
tmem contrib raw <subject-id>
```

This prints `{commits, prs, reviewComments, issues}` (bots/forks/generated files
already filtered). If it errors with "gh not found" or auth failure, tell the
user to run `gh auth login` and stop.

### 2. Classify into the 11 dimensions

For each meaningful signal, write ONE atom tagged with exactly one dimension.
Never invent style — every atom needs at least one evidence link (`PR#<n>` or
commit sha).

**Technical Craft**
- `idea` — how they frame problems / pick work. Source: issue bodies (repro,
  expected-vs-actual, root-cause vs symptom), PR "why" sections.
- `plan` — PR decomposition & scoping. Source: PR size (additions+deletions),
  commits-per-PR, whether each PR is self-contained.
- `solve` — coding/refactor patterns. Read diffs through Ousterhout's lens: deep
  vs shallow modules, information leakage, strategic vs tactical, errors designed
  out of existence.
- `craft` — review thinking in comments they WROTE: do they cite the why, weigh
  alternatives, label severity ("Nit:", "Optional:").

**Collaboration & Influence**
- `comms` — commit message quality (subject ≤50 chars, body explains why,
  imperative mood) and PR description clarity.
- `mentor` — review comments that teach/explain vs cosmetic-trivia floods.
- `conflict` — review threads they RECEIVED: do they update their view, push back
  constructively, avoid needless blocking.

**Outcomes & Ownership**
- `scope` — cross-repo/cross-area reach, size of areas touched.
- `ownership` — test-inclusion rate, concentration on components.
- `execution` — revert rate, post-merge rework, review coverage of merged work.

### 3. Write each atom

```bash
tmem contrib upsert-atom --json '{"record_id":"<id>:<dim>:<hash>","subject_id":"<id>","dimension":"plan","content":"Splits features by concern; median PR ~280 LOC, ~5 commits each.","evidence":["PR#1234","PR#1240"]}'
```

- `record_id` must be stable (e.g. `<subject-id>:plan:<short-hash-of-claim>`) so
  re-ingest upserts instead of duplicating.
- Keep `content` to one concrete, emulable observation.

### 4. Guardrails (do NOT violate)

- Tone/sentiment is descriptive only — never a score or ranking.
- No vanity claims (stars, streaks, total commits, raw LOC counts).
- Skip a dimension rather than fabricate a weak claim. If a subject has <50 PRs,
  note which dimensions are "insufficient data" in the atom content.

### 5. Report

Tell the user how many atoms were written per dimension and any dimensions left
empty for lack of evidence.
