# Synthesis Guide — playbook, quotes, compare, L4

Read this before synthesising. The product's whole differentiator is
**interpretation for learners** — turn a top engineer's trail into something the
user can act on. Measurement is the means, not the output.

## Learnable playbook

Distil a persona into **≥8 emulable heuristics** — each concrete enough to copy
tomorrow, each traceable to evidence in the persona/atoms.

The altitude test: a heuristic should be an *instruction to yourself*, not a
description of the subject.
- Good: "Split features into ≤150-LOC stacked PRs, one concern each."
- Good: "Ship every bug-fix PR with its regression test in the same diff."
- Too vague: "Be organized." / "Write good PRs." (not actionable)
- Too specific: "Rename the helper in PR #1234" (overfit to one PR, not a habit)

Group heuristics loosely by cluster (craft / collaboration / outcomes) if there
are many. Lead each with the imperative verb.

## Exemplar quotes

From the subject's review comments (in atom evidence / `reviewCommentsGiven` /
`reviewThreadsReceived`), surface 3–5 of the **best teaching moments verbatim**,
each paired with the principle it illustrates. Pick comments that teach a
transferable idea, not project-specific chatter.

> "allocation-free but more CPU — fine because decoding is rare and cached" →
> *principle: state the trade-off explicitly when defending a design choice.*

Quote real text; never paraphrase into the subject's mouth.

## You-vs-role-model compare

Two distinct modes — pick by what the user is comparing:

**You vs a role model** (the common case): the user's side is their *existing*
self-persona (`tmem persona`, built from their Claude Code history) — never make
them ingest their own GitHub. The role model's side is `tmem contrib persona
<id>`. The two schemas differ, so this is a **qualitative gap analysis**: per
role-model dimension, name the habit, what the user's persona implies (or "not
evidenced"), and one thing to adopt. The gap-to-close line is the point.

**Two profiled contributors** (peer/team): both have 11-dimension contributor
personas, so the deterministic per-dimension table (`tmem contrib compare <a>
<b>`) applies — one line each, side by side.

Honesty (both modes): tone/style differences are descriptive, never
"better/worse". Different top engineers embody opposite valid styles (breadth +
low-ego revision vs narrow-depth + opinionated stewardship) — frame as *paths*,
not a ranking.

## L4 capability narration

`tmem contrib capabilities` gives the deterministic backbone (which dimensions
are common across subjects, prevalence %, exemplar). For each common capability
write 1–2 sentences: the shared behaviour, the prevalence ("N/M subjects"), and
the exemplar with one piece of their evidence.

Caveat to always state: the L4 model is **preliminary until ≥3 subjects** — with
2 it describes those two, not "top SWEs" in general. Say so plainly.
