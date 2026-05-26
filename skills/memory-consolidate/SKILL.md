---
name: memory-consolidate
description: Consolidate L1 memory atoms into L2 scene blocks and L3 persona. Triggers when the user says "consolidate memories", "build persona", "update persona", "create scenes", or after /memory-seed completes. Also triggers automatically via the asyncRewake pipeline after N conversation turns.
---

# Memory Consolidation

Analyze L1 atoms and produce higher-level structures. You (the agent) perform all reasoning — no external LLM needed.

## When to use

- After memory-seed skill extracts L1 atoms
- When asyncRewake pipeline triggers consolidation
- When user asks to "consolidate", "build persona", or "update scenes"

## Workflow

### 1. Check current state

```bash
tmem status
```

### 2. List existing scenes (for dedup)

```bash
tmem scenes list
```

### 3. Load L1 atoms

```bash
tmem atoms all
```

### 4. Generate L2 scene blocks

Group project-scoped atoms by topic. **Reuse existing scene names** from step 2 when the topic matches — this updates the file instead of creating a duplicate.

```bash
echo 'MARKDOWN_CONTENT' | tmem write-scene --name "Scene Name" --summary "One-line summary" --heat 3
```

**Scene guidelines:**
- Group by topic, not by session
- Reuse existing scene names when topic matches
- Include key facts, decisions made, and outcomes
- Heat: 1-5 (higher = more recent activity)

### 5. Generate L3 persona

Read existing persona:

```bash
tmem persona
```

Write updated persona (merge new insights, don't replace):

```bash
echo 'PERSONA_CONTENT' | tmem write-persona
```

**Persona structure:**
```markdown
# User Persona

## Identity
- Role, background, expertise

## Preferences
- Tools, styles, communication preferences

## Working Style
- Patterns, habits, workflow characteristics

## Standing Instructions
- Long-term rules for AI behavior
```

Keep under 500 words.

### 6. Mark complete

```bash
tmem mark-done
```

After consolidation, tell the user: **Memory pipeline complete.** Hybrid recall is now active.
