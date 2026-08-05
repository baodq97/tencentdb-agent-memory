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

### 3. Load L1 atoms — the DELTA since last consolidation, not the whole pool

Consolidation is incremental: read only atoms written since the last run, so the
pool you reason over stays bounded no matter how large the store grows (upstream
keys the same read on a `last_extraction_updated_time` cursor).

```bash
tmem atoms project --since-last     # only project atoms updated since the last consolidation
```

On a cold start (no watermark yet) this returns the full pool, which is correct
for the first run. `tmem mark-done` (step 6) advances the watermark, so each
subsequent run sees only new atoms. To force a full re-read, use `tmem atoms
project` (no flag) or `--since <iso-timestamp>` for an explicit cursor.

For global atoms (persona/instruction types), same delta scoping:

```bash
tmem atoms global --since-last
```

### 3b. Verify & dedup atoms before consolidating (close the loop)

Do not consolidate atoms blindly — the measured store was ~40% junk/duplicate and
16% of mined "fixes" were themselves errors. First remove exact duplicates with the
hard script:

```bash
tmem dedup --atoms --dry-run     # then --apply if the plan looks right
```

Then, for the remaining atoms, decide per atom against the existing pool (search
candidates with `tmem search "<key phrase>"`):

- **store** — genuinely new information → keep.
- **skip** — an existing atom already says it (no increment, or vaguer) → drop.
- **update** — same fact, this atom is more specific/newer/corrects the old → fold
  the correction in, keep the union of timestamps, do NOT inflate priority.
- **merge** — same fact/evolution across several atoms → combine into one complete,
  non-redundant atom.

Drop a mined error→fix atom whose fix ITSELF errored later in the transcript
(flailing) — a wrong fix enshrined as a rule is worse than none. Cross-type merges
are allowed (an episodic + a persona describing the same fact → one atom of the
better type).

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

**How scene-body FACTS are delivered** (the body is a per-turn recall surface now, not just an on-demand read):

Each `- ` bullet under `## Key Facts` and `## Decisions` is indexed and, every
turn, ranked against the user's prompt and injected — the top few — into a
`<recalled-facts>` block (own budget, ~700 chars, project scenes first). This is
the PRIMARY per-turn memory: raw L1 episodic atoms are no longer recalled (they
were measured to echo the current turn, 1/10 helpful), so a fact reaches a future
agent ONLY if it is a scene-body bullet here. Measured: distilling facts into this
block lifted real-query helpfulness from 1/10 to 5/10.

So write each bullet as a **self-contained answering fact that carries the
outcome**, not a topic label:

- **Stand alone.** A bullet is recalled without its scene around it. "Fixed the
  launcher bug" is useless out of context; "tmem.js resolved the plugin-cache
  cli.js before its own sibling, so `npx @baodq97/tmem` ran stale code — fixed by
  making the sibling authoritative (v0.7.3)" answers the question by itself.
- **Carry the result / number, not just the subject.** The two recall misses that
  remained were bullets that said a topic was *discussed* but not what was
  *decided or measured*. "Reviewed embedding quality" → instead: "EmbeddingGemma-300M
  is the model; multilingual EN+VI confirmed adequate, no swap recommended." Put
  the verdict, the figure, the path, the version IN the bullet.
- **One fact per bullet, distinguishing token first** — the ranker scores by query
  overlap, so lead with the noun a future prompt would search for.
- A bullet that is just an echo of a user turn ("ok, ship it") is not a fact —
  drop it. Only durable, reusable facts earn a bullet.

**How the summary is delivered** (write for the reader, it cannot summarise you):

The `--summary` is not part of the scene body. It becomes one line in the per-turn scene-navigation block — `- Scene Name (heat=5 🔥🔥) <summary>` — and that block has a hard **800-char** budget. The renderer truncates every summary at **80 characters** and appends `...`. Whatever you write past character 80 is displayed nowhere, in any surface: not in the nav, not on the way to the body. It is not "extra detail", it is discarded text.

Last measurement: real summaries averaged **164 chars** (median 152), so a rendered nav line ran ~130 chars and the 800-char budget fitted about **5 lines**. The store held **219 scenes** — **214 of them were unreachable in a given turn**. Query-ranked ordering changed *which* five appear; it cannot change *how many*, because the count is bounded by line width. That is fixable only here, on the write side.

**Summary-length rule: 80 characters — about 12 words — hard ceiling.**

The derivation is the truncation point itself: at 80 chars the renderer cuts, so 80 is the longest summary that is fully shown. Aim at ~60. Every char you save is budget that buys another scene a line in the same block.

Check your own output before writing it — no tool needed:

- An 80-char summary is **one wrapped line at 80 columns**. If it wraps to a second line, it is over.
- Or count words: **≤ 12**. If you have to re-read it to know, it is too long.

**A summary is a signpost, not an abstract.** Its only job is to let the reader decide whether to run `tmem scene <name>`. It should name the subject and the distinguishing detail — enough to tell this scene apart from its neighbours — and nothing else. The full narrative lives in the scene body, readable in whole via `tmem scene <name>`; its individual bullets are ALSO recalled per turn (see the next section), so the body is no longer a budget-free dumping ground. Do not restate the body in miniature; do not open with "This scene covers…". Lead with the distinguishing noun, since the tail is what gets cut.

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

### 5. Generate L3 — TWO documents by scope (the hybrid model)

L3 is split by scope, and **scope selects the family**:

- **Global persona (`--scope global`, chat family)** — who the *user* is across ALL
  projects: identity, durable preferences, communication register, standing rules.
- **Project doctrine (`--scope project`, code/team family)** — how work is done in
  *this repo*: SOPs, decision logic, boundaries, anti-patterns, agent rules. NOT the
  user's personality, NOT project trivia (version numbers, one-off task status).

Write global from persona/instruction-type atoms; write project doctrine from this
repo's scenes + work atoms. A rule that holds across projects belongs in global; a
rule that only makes sense inside this repo belongs in project doctrine. When unsure,
prefer project (a wrong global rule pollutes every repo).

Both writes pass the **budget gate** (`tmem write-persona` rejects a document whose
`always` rules would overflow the tier-0 budget, or whose bullets break the 160-char
rule). Compress until it accepts; do not `--force` unless a human told you to.

#### 5a. Global persona (chat family)

Read existing global persona:

```bash
tmem persona
```

Merge new insights from persona-type and instruction-type atoms. Don't replace — evolve. Evolving includes shortening: apply the bullet-length rule below to the bullets you carry forward, not only to the ones you add.

**Priority cap (don't amplify on merge):** merging combines evidence; it must NOT inflate importance beyond the strongest source. When you fold several atoms into one persona point or standing instruction, the merged item's weight (priority/prominence) MUST be `≤ max(priority)` of the contributing atoms — never higher just because it was repeated or merged. A single scene-local instruction must not be promoted into a dominant global rule unless the source atoms' own priority already justifies it. Likewise, scene `--heat` reflects recency, not merge count: repetition across sessions is not evidence of higher priority.

```bash
cat <<'PERSONA_EOF' | tmem write-persona --scope global
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

**Project tags: a `conditional` bullet that applies to only one project MUST end its label with `(<project-name>)`.**

The persona is ONE global document, but tier-1 bullets are injected into every repo you work in. An untagged rule about one project's build script arrives in every other project as a standing instruction, and the agent cannot tell from inside the block that it does not apply here. Measured: a rule about a `tools/kg.py` that exists in one repo alone was selected while working in a different one — not a smaller persona, a wrong one.

So write the tag on the label, at the end, before the colon: `- **Eval runs** (orchard-api): always run the suite twice and report both numbers.` One to three words, the project's name as you would say it. Body prose is not searched, and a parenthetical anywhere else is read as an aside, not a tag.

**No tag means the rule is universal, and that default is deliberate.** The reader keeps everything it cannot confidently place — an untagged bullet, an unparseable tag, a project it cannot identify all resolve to "apply it". Dropping a real standing rule is far worse than occasionally injecting a foreign one, so the tag is the only thing that can ever narrow a bullet's reach. If a rule truly is project-specific, it is on you to say so; if it is general, say nothing.

#### 5b. Project doctrine (code/team family)

Read the existing doctrine (may be empty on first run):

```bash
tmem persona --scope project    # falls back to nothing if none yet
```

Distil this repo's scenes + work atoms into a REUSABLE Operating Doctrine — the
rules a future agent needs to work here well. Not a project summary, not a scene
index, not task status. Each rule must be understandable outside its original
session (name the action, the condition, the reason).

**Filter every rule before writing (drop if any answer is no):** is it reusable
across tasks in this repo? complete out of context? something an agent can act on?
stable, not one-off status? as short as it can be?

**Keep OUT of doctrine:** the user's personality/preferences (those are global
persona), version numbers, one-off task states, PR/issue names — unless they encode
a reusable rule.

```bash
cat <<'DOCTRINE_EOF' | tmem write-persona --scope project
# Team Operating Doctrine

## Core Principles
- <principle>: <when it applies / why it matters>

## Reusable SOPs
- <name>: when <trigger>, first <step>, then <step>, verify <check>.

## Decision Logic
- When <situation>, prefer <A> over <B>, because <reason>.

## Boundaries & Anti-patterns
- Don't <mistake>; do <fix> instead, because <reason>.

## Agent Rules
- The agent should <behaviour>, to avoid <risk>.
DOCTRINE_EOF
```

The 160-char bullet rule and the budget gate apply here exactly as for the global
persona — the project block is injected once per session by SessionStart, same
tier-0 economics. Evolve, don't append: fold new evidence into existing rules and
shorten as you go; if nothing reusable is new this round, leave the doctrine unchanged.

### 6. Mark complete

```bash
tmem mark-done
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
