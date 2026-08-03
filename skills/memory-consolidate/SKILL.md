---
name: memory-consolidate
description: Consolidate L1 memory atoms into L2 scene blocks and L3 persona. Invoked by the memory-consolidator agent, or manually via /memory-consolidate.
---

# Memory Consolidation

Analyze L1 atoms and produce L2 scene blocks + L3 persona. You perform all reasoning — no external LLM needed.

## Workflow

### 1. Check current state

```bash
tmem status
```

If zero records exist, tell the user to run memory-seed first and stop.

### 2. List existing scenes

```bash
tmem scenes list
```

Note existing scene names — you will reuse them when topics match to avoid duplicates.

### 3. Load L1 atoms

```bash
tmem atoms project
```

If output is very large (200+ records), focus on records since last consolidation by checking `tmem changelog --last 50` for recent writes.

For global atoms (persona/instruction types):

```bash
tmem atoms global
```

### 4. Generate L2 scene blocks

Group project-scoped atoms by topic into narrative scenes.

**Important:** If a scene with the same topic already exists from step 2, reuse that exact name so the file gets updated instead of duplicated.

Write each scene using a heredoc to handle multiline content:

```bash
cat <<'SCENE_EOF' | tmem write-scene --name "Scene Name" --summary "One-line summary, max 80 chars" --heat 3
## Key Facts
- Fact 1
- Fact 2

## Decisions
- What was decided and why
SCENE_EOF
```

**Guidelines:**
- Group by topic, not by session
- Aim for 5-15 scenes per project — fewer if topics are narrow, more if diverse
- Heat 4-5: active this week. Heat 2-3: recent but not current. Heat 1: historical. Only heat 5 (two flames) and heat 4 (one flame) get a flame cue in the nav; 1-3 render none, so reserve 4-5 for genuinely current work rather than defaulting there.
- Each scene should be understandable on its own

**How the summary is delivered** (write for the reader, it cannot summarise you):

The `--summary` is not part of the scene body. It becomes one line in the per-turn scene-navigation block — `- Scene Name (heat=5 🔥🔥) <summary>` — and that block has a hard **800-char** budget. The renderer truncates every summary at **80 characters** and appends `...`. Whatever you write past character 80 is displayed nowhere, in any surface: not in the nav, not on the way to the body. It is not "extra detail", it is discarded text.

Last measurement: real summaries averaged **164 chars** (median 152), so a rendered nav line ran ~130 chars and the 800-char budget fitted about **5 lines**. The store held **219 scenes** — **214 of them were unreachable in a given turn**. Query-ranked ordering changed *which* five appear; it cannot change *how many*, because the count is bounded by line width. That is fixable only here, on the write side.

**Summary-length rule: 80 characters — about 12 words — hard ceiling.**

The derivation is the truncation point itself: at 80 chars the renderer cuts, so 80 is the longest summary that is fully shown. Aim at ~60. Every char you save is budget that buys another scene a line in the same block.

Check your own output before writing it — no tool needed:

- An 80-char summary is **one wrapped line at 80 columns**. If it wraps to a second line, it is over.
- Or count words: **≤ 12**. If you have to re-read it to know, it is too long.

**A summary is a signpost, not an abstract.** Its only job is to let the reader decide whether to run `tmem scene <name>`. It should name the subject and the distinguishing detail — enough to tell this scene apart from its neighbours — and nothing else. The full narrative belongs in the scene body, which is loaded on demand and has no budget. Do not restate the body in miniature; do not open with "This scene covers…". Lead with the distinguishing noun, since the tail is what gets cut.

**This applies to summaries you are only carrying through, not just to new ones.** When you reuse an existing scene name (step 4), you rewrite its summary too — pass the old one through the same 80-char test and shorten it. Scenes you never re-touch keep their over-long summaries forever, so shortening on re-consolidation is the only path by which an already-bloated store improves.

Example, using synthetic data:

```
before (171 chars — cut at 80, the rest never rendered):
--summary "Investigation into why the Orchard API deploy pipeline was failing on
  Node 20, including the pnpm lockfile mismatch Dev Aster found and the CI matrix
  change that finally fixed it"

after (58 chars):
--summary "Orchard API deploy failed on Node 20: pnpm lockfile mismatch"
```

The dropped clauses are not lost — they are Key Facts and Decisions in the scene body, where they belong.

### 5. Generate L3 persona

Read existing persona:

```bash
tmem persona
```

Merge new insights from persona-type and instruction-type atoms. Don't replace — evolve. Evolving includes shortening: apply the bullet-length rule below to the bullets you carry forward, not only to the ones you add.

**Priority cap (don't amplify on merge):** merging combines evidence; it must NOT inflate importance beyond the strongest source. When you fold several atoms into one persona point or standing instruction, the merged item's weight (priority/prominence) MUST be `≤ max(priority)` of the contributing atoms — never higher just because it was repeated or merged. A single scene-local instruction must not be promoted into a dominant global rule unless the source atoms' own priority already justifies it. Likewise, scene `--heat` reflects recency, not merge count: repetition across sessions is not evidence of higher priority.

```bash
cat <<'PERSONA_EOF' | tmem write-persona
# User Persona

## Identity
- Role, background, expertise

## Preferences
- Tools, styles, communication preferences

## Working Style
- Patterns, habits, workflow characteristics

## Standing Instructions
- Long-term rules for AI behavior
PERSONA_EOF
```

**How this persona is delivered** (write for the reader, it cannot summarise you):

Nothing is injected wholesale any more. Every bullet is classified by duty and sent on one of three channels:

- **tier 0 `always`** — standing rules, preferences, register. Injected **once per session**, into a hard **4 800-char** budget (`tmem persona-max-tokens`, default 1200 tok).
- **tier 1 `conditional`** — situational rules (`When…`, `Before…`). Injected **per turn**, only when the prompt matches, into ~420 chars.
- **tier 2 `reference`** — paths, versions, inventory. **Never injected**; read on demand via `tmem persona --section <name>`.

So the 4 800 chars is a real contract, and only tier-0 content competes for it. The reader can only truncate or drop — never condense. Overflow is therefore silent data loss, and it lands on standing instructions.

Last measurement: the persona carried **47 `always`-duty bullets**; **14** were delivered (**4 566** chars of the 4 800 budget) and **33 were dropped**. Notice what that says — the budget was ~95% spent and still two thirds of the standing rules never reached the agent. Raising the budget cannot fix this. The persona averaged **478 chars per bullet**, and 4 800 ÷ 478 ≈ 10 bullets, so at that length roughly ten rules fit *whatever* the budget is tuned to. This is a bullet-length problem, and it is only fixable here, on the write side.

**Bullet-length rule (tier-0 `always` bullets): 160 characters — about 25 words — hard ceiling.**

The derivation: a persona should be able to deliver on the order of **30** standing rules, and 4 800 ÷ 30 = **160**. Aim at ~120 chars so a section can carry a couple of longer ones without pushing the set over. A bullet at today's 478-char average consumes the tier-0 slot of three rules.

Check your own output before writing it — no tool needed:

- A 160-char bullet is **two wrapped lines at 80 columns**. Three lines means it is over.
- Or count words: **≤ 25**. If you cannot count them at a glance, it is too long.
- Same test on `## Standing Instructions` as a whole: more than ~30 `always` bullets across the whole persona means the set is over budget even if every bullet passes. Demote the least operative ones to reference-y sections.

**A long bullet is not a long rule — it is two rules.** When one runs over, split it into separate bullets, or move the explanatory half to tier 2; do not truncate it and do not shave it down to a cryptic fragment. "Prefers pnpm over npm; also wants lockfiles committed; and CI must run on Node 20" is three bullets, not one.

Write accordingly: **one rule per bullet, operative clause first**, so a bullet that has to be cut still says the right thing; put paths/versions/inventory under reference-y headings where they cost nothing rather than crowding the tier-0 budget. Prefer merging near-duplicate rules over appending another one.

**This applies to bullets you are only re-reading, not just to new ones.** Consolidation rewrites the whole persona, so every over-long bullet you carry through unchanged stays over-long forever. When merging (step 5), pass each existing `always` bullet through the same 160-char test and split or tighten the failures as you go — that is the only path by which an already-bloated persona improves. Splitting one bullet into two does **not** count as amplification under the priority cap above: both halves inherit the original's priority, neither is promoted.

Example of the rewrite, using synthetic data:

```
before (312 chars, one bullet):
- Dev Aster prefers TypeScript with strict mode enabled for all new services and
  dislikes `any`; when reviewing code he wants the reviewer to flag missing return
  types, and his projects live under -home-dev-projects-orchard-api so that is where
  the tsconfig baseline lives.

after (three bullets, tier-separated):
- Use TypeScript strict mode for new services; never `any`.            (always, 62)
- When reviewing code, flag missing return types.                      (conditional, 47)
- tsconfig baseline: -home-dev-projects-orchard-api/tsconfig.json      (reference, 62)
```

### 6. Mark complete

```bash
tmem mark-done
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
