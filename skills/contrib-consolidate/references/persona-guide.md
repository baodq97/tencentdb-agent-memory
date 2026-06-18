# Persona-Building Guide

Read this before writing a persona. Consolidation turns scattered atoms into one
coherent picture per subject — the value is synthesis, not concatenation.

## Per-dimension synthesis

For each of the 11 dimensions, read all atoms in that dimension and write 1–3
sentences that capture the *pattern*, not a list. Carry the 1–2 strongest
evidence links into the prose.

- **Merge, don't list.** Three atoms about small PRs, stacked PRs, and one
  concern each → one sentence: "Decomposes features into small, single-concern,
  often-stacked PRs." A bulleted re-dump of the atoms is a failure.
- **Resolve conflicts honestly.** If atoms disagree (e.g. one says "reverts
  fast", another "lets contentious work sit"), that's usually not a contradiction
  but a nuance — state both: "Decisive on clear calls, but parks genuinely
  uncertain work rather than forcing it." If they truly conflict, prefer the one
  with stronger/more-recent evidence and note the tension.
- **Weight by evidence.** A dimension backed by 4 atoms across many PRs is a
  confident claim; one backed by a single weak atom should be hedged ("appears
  to…") or marked "insufficient data".

## insufficient data

Set a dimension to exactly `"insufficient data"` when its atoms are absent or too
thin to support a claim. This is honest and feeds the L4/KPI logic (a dimension
only counts as "present" for capability synthesis when it's non-empty and real).
Do not pad a dimension to avoid the label.

## summary and notable_traits

- `summary` (2–3 sentences): the *one-paragraph* answer to "how does this person
  work?" — the throughline that ties the dimensions together, not a restatement
  of all eleven.
- `notable_traits` (3–6): distinctive things that don't map cleanly to a fixed
  dimension — a personal signature ("writes prose-quality commit bodies",
  "defends defaults firmly"). These give the persona individuality the fixed
  dimensions can't.

## Quality bar

A good persona lets a reader predict how the subject would approach a *new* task
they've never seen. If it only describes the specific PRs in the atoms, it's
overfit — generalise to the underlying habit.
