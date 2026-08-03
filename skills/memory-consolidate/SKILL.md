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
cat <<'SCENE_EOF' | tmem write-scene --name "Scene Name" --summary "One-line summary" --heat 3
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
- Heat 4-5: active this week. Heat 2-3: recent but not current. Heat 1: historical.
- Each scene should be understandable on its own

### 5. Generate L3 persona

Read existing persona:

```bash
tmem persona
```

Merge new insights from persona-type and instruction-type atoms. Don't replace — evolve.

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

So the 4 800 chars is a real contract, and only tier-0 content competes for it. Today the persona holds ~22 000 chars of `always`-duty against that budget — ~4x oversubscribed — and the reader can only truncate or drop, never condense. Overflow is therefore silent data loss, and it lands on standing instructions.

Write accordingly: **one rule per bullet, operative clause first**, so a bullet that has to be cut still says the right thing; put paths/versions/inventory under reference-y headings where they cost nothing rather than crowding the tier-0 budget. Prefer merging near-duplicate rules over appending another one.

### 6. Mark complete

```bash
tmem mark-done
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
