---
name: contrib-profile
description: One-shot entry point for Contributor Intelligence — the user just drops a GitHub link or names an engineer and you take it from there. Use this whenever someone pastes a GitHub profile/repo URL (github.com/<user> or github.com/<user>/<repo>) or a handle and asks to "profile", "analyze how X works", "learn from X", "study this engineer", "phân tích người này", "học từ người này", or asks "how do I use /contrib". Drives the whole pipeline end-to-end (add → ingest → build → playbook), or guides the user through it if they'd rather drive. This is the orchestrator — the per-phase skills (contrib-ingest, contrib-consolidate, contrib-synthesize) do the actual work; do NOT use this one to inspect or synthesize an already-built persona (use contrib-synthesize) or for the self-memory feature.
---

# Contributor Profile — A→Z orchestrator

The friendly front door to the `/contrib` feature. The user shouldn't have to know
the subcommand sequence — they give you a target and an intent, and you either run
the whole pipeline for them or walk them through it.

## 1. Figure out the target

Accept any of these and normalise to `<github_user>` + `<owner/repo>`:
- a profile URL — `https://github.com/<user>`
- a repo URL — `https://github.com/<owner>/<repo>`
- a handle — `<user>`, `<owner>/<repo>`, or an existing subject id `<user>@<repo>`

If you only have a **user** (no repo), the profile needs a repo to scope ingest.
Find their most relevant repo instead of guessing:

```bash
gh api "users/<user>/repos?sort=pushed&per_page=20" --jq 'sort_by(-.stargazers_count) | .[] | select(.fork|not) | "\(.full_name)\t★\(.stargazers_count)"' | head
```

Pick the top owned repo where they actually **author code** — by stars/activity.
Skip forks, and skip non-code repos that rank high on stars but carry no
engineering signal (awesome-lists, dotfiles, docs/blog repos). If it's genuinely
ambiguous (several comparable code repos, or they're mainly a reviewer), show the
short list and ask which one rather than guessing.

## 2. Preflight

```bash
gh auth status
```

If `gh` is missing or unauthenticated, stop and tell the user to run
`gh auth login`. Nothing downstream works without it.

## 3. Decide the mode

- **Do-it-all** (default when the user said "profile / analyze / learn from"):
  run the whole pipeline yourself, reporting progress between phases.
- **Guide** (when the user asked "how do I use this" or wants to drive): lay out
  the steps below as a checklist and run only what they ask for, one at a time.

## 4. Run the pipeline (do-it-all)

Execute in order. Each phase has a dedicated skill — invoke it, don't reinvent it.

1. **Declare** (idempotent — skip if already a subject):
   ```bash
   tmem contrib add <user> <owner/repo>
   ```
2. **Ingest** — invoke the **contrib-ingest** skill, which fetches raw activity
   (`tmem contrib raw <id>`) and writes 11-dimension atoms. Mention it can take a
   minute or two for an active engineer (per-PR calls).
3. **Consolidate** — invoke the **contrib-consolidate** skill to turn the atoms
   into the L3 persona.
4. **Synthesize** — invoke the **contrib-synthesize** skill to produce the
   learnable playbook (and exemplar quotes).

Then present, in this order:
- a 2–3 sentence summary of how this engineer works,
- the **learnable playbook** (the emulable heuristics — the payoff),
- a pointer to what's next (below).

## 5. Offer the next moves

After the first profile, surface the high-value follow-ups so the user knows the
feature's range — pick what fits their intent, don't dump all of them:
- `tmem contrib persona <id>` — the full 11-dimension dossier with evidence.
- **You vs them** — invoke contrib-synthesize's compare against the user's
  existing self-persona (`tmem persona`); no need to ingest the user from GitHub.
- **Capability model** — profile a 2nd engineer, then `tmem contrib capabilities`
  to see what top engineers share (needs ≥2 built personas).
- `tmem contrib trajectory <id>` — their per-year cadence/style arc.
- `tmem contrib team add/capabilities` — group several into a team model.

## 6. Guardrails

- This skill only **orchestrates** — the per-phase skills own classification and
  synthesis quality (and their `references/` rubrics). Don't duplicate their logic.
- Everything is evidence-linked and stored under `<global>/contributors/` — the
  self-memory feature is never touched.
- Be honest about scope: cadence/style is measured, PR diff size is not.
