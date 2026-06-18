# Dimension Classification Rubric

Read this before classifying. The goal of an atom is one concrete, **emulable**
observation backed by evidence — something a learner could copy. Vague praise
("writes good code") is useless; specific behaviour with a link is gold.

## What makes an atom good vs shallow

A **good** atom names a *behaviour*, gives a *specific* detail (a number, a named
pattern, a verbatim phrase), and links evidence:

> `{dim:"plan", content:"Splits a feature into stacked PRs by component (each layer in its own PR), each independently reviewable.", evidence:["PR#<n1>","PR#<n2>","PR#<n3>"]}`

A **shallow** atom restates the dimension or praises without specifics — reject it:

> ❌ `{dim:"plan", content:"Plans PRs well and is organized.", evidence:[]}`
> ❌ `{dim:"craft", content:"Writes high-quality code.", evidence:["PR#12"]}`  (no observable behaviour)

**Evidence strength:** prefer 2+ links showing a *pattern* over a single instance.
A behaviour seen once is an anecdote; seen across PRs it's a trait. If you can
only find one weak instance, lower the atom's `priority` or skip it.

**Honesty:** if a dimension has no real signal in the raw data, do NOT invent one
— set the eventual persona dimension to "insufficient data". Tone/sentiment is
descriptive only, never a score. No vanity counts (stars, total commits, LOC).

---

## Technical Craft

### `idea` — problem framing, picking what to work on
Source: `issues` they opened, PR "why" sections.
Look for: do they state the problem before the solution? repro steps,
expected-vs-actual, root-cause vs symptom? do they pick leverage (a fix that
unblocks many) over busywork?
- Good: "Frames issues with repro + expected-vs-actual before proposing a fix (issue #<n>)."
- Shallow: "Opens good issues."

### `plan` — PR decomposition & scoping
Source: PR count/size, commits-per-PR, stacked-diff base refs, self-containment.
Look for: small single-concern PRs vs giant ones; stacked/dependent PR chains;
whether each PR stands alone.
- Good: "Median PR ~280 LOC, ~5 commits, one concern each; stacks dependent PRs."
- Shallow: "Makes small PRs."

### `solve` — coding & refactor patterns (Ousterhout lens)
Source: diffs, commit messages, files touched, tests.
Read through *A Philosophy of Software Design*:
- **Deep vs shallow modules**: deep = simple interface hiding real complexity;
  shallow = interface as complex as its body (little value, leaks detail).
- **Information leakage**: a design decision exposed across multiple modules.
- **Strategic vs tactical**: investing in clean structure vs bolting on the
  quickest patch.
- **Define errors out of existence**: designing APIs so error cases can't arise.
Look for: extracting cohesive units before building on them; validating input at
boundaries; guarding numeric/edge cases.
- Good: "Defensive at boundaries — rejects malformed input and guards against overflow (<sha>); extracts a cohesive unit before layering an API on top of it (PR#<n>)."
- Shallow: "Fixes bugs and refactors."

### `craft` — review thinking in comments they WROTE (`reviewCommentsGiven`)
Look for: do they cite the *why*, weigh alternatives, label severity ("Nit:",
"Optional:"), reason about trade-offs out loud (CPU vs allocation), flag adjacent
risks found while reviewing?
- Good: "Reasons about trade-offs in-thread (e.g. allocation-free but more CPU, acceptable because the path is rare and cached) and flags adjacent risks found while reviewing (PR#<n>)."
- Shallow: "Leaves helpful reviews."

---

## Collaboration & Influence

### `comms` — communication quality
Source: commit subjects/bodies, PR descriptions.
Look for: subject ≤~50 chars, imperative mood, scoped/conventional prefix; body
explains *why* not just *what*; PR descriptions that orient the reader.
- Good: "Scoped conventional subjects (e.g. `fix(parser):`), ~half of commits carry an explanatory body."
- Shallow: "Good commit messages."
Note: terse non-conventional style is also a valid finding — describe it, don't judge it.

### `mentor` — teaching vs nitpicking (`reviewCommentsGiven`)
Look for: comments that explain history/context and the why, encode rationale in
code comments, vs floods of cosmetic trivia.
- Good: "Teaches the why of API choices and adds code comments to preserve rationale, rather than nitpicking style."

### `conflict` — handling disagreement (`reviewThreadsReceived`, their own replies)
Look for `is_subject:true` replies: do they update their view, push back with
reasoning, or hold the line constructively? avoid needless blocking?
- Two valid opposite findings: "Low-ego — revises own approach mid-thread ('don't like this approach')" OR "Holds the line on defaults with reasoning, redirecting to existing primitives." Either is a real trait; capture which.

---

## Outcomes & Ownership (mostly deterministic)

### `scope` — reach & impact
Look for: breadth across components/areas, or deliberate narrow-and-deep mastery.
- Good (breadth): "Works across several subsystems (e.g. core engine, storage, UI, public API)."
- Good (depth): "Narrow-and-deep — one library polished to high quality."

### `ownership` — reliability & stewardship
Look for: test-inclusion with fixes, controlled/minimal public API surface,
consistent stewardship of components.
- Good: "Stewards the public API via small explicit getters, refusing to leak internals."

### `execution` — shipping discipline
Look for: revert/back-out when wrong, frequent small releases, post-merge rework.
- Good: "Ships decisively, reverts cleanly when an approach is wrong (<sha>)."

---

## record_id convention

Use a stable id so re-ingest upserts instead of duplicating:
`<subject-id>:<dim>:<short-hash-or-slug-of-the-claim>`, e.g. `<subject-id>:plan:stacked`.
