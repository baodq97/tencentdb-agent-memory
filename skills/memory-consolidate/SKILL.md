---
name: memory-consolidate
description: Consolidate L1 memory atoms into L2 scene blocks and L3 persona. Triggers when the user says "consolidate memories", "build persona", "update persona", "update scenes", "organize memories", or after memory-seed completes. Also triggers via asyncRewake pipeline after N conversation turns. This skill is about ORGANIZING existing memories into higher structures — for creating memories from transcripts use memory-seed instead.
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

Keep under 500 words — this gets injected into every turn's recall context.

### 6. Mark complete

```bash
tmem mark-done
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
