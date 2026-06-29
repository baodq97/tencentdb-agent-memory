---
name: memory-seed
description: Extract L1 memory atoms from Claude Code conversation history. Triggers when the user says "seed memories", "extract memories", "backfill memory", "remember my history", "learn from past conversations", "what do you know about me", or after /memory-init when conversation history exists. Also use when asyncRewake pipeline flags pending sessions. This skill is about CREATING new memories from transcripts — for inspecting existing memories use tmem-cli instead.
---

# Memory Seeding

Read conversation transcripts from `~/.claude/projects/` and extract structured L1 memory atoms. You perform all extraction — no external LLM needed.

## Workflow

### 1. Find pending sessions

```bash
tmem sessions
```

If no pending sessions, tell the user and stop.

### 2. For each pending session

Read the conversation:

```bash
tmem read-session SESSION_FILE_PATH
```

### 3. Extract memories

Read the extraction guide for detailed rules:

```bash
cat ${CLAUDE_PLUGIN_ROOT}/skills/memory-seed/references/extraction-guide.md
```

Analyze the conversation and produce a JSON array of memories. Each memory needs `content`, `type`, `priority`, `scene_name`, `source_message_ids`, `metadata`.

**Grounding (important):** populate `source_message_ids` with the actual transcript message `uuid`s the memory was drawn from. `tmem write-l1 --session` runs a deterministic grounding check — an atom whose `content` does not overlap its cited source messages is **dropped as confabulation**. Leaving `source_message_ids` empty skips the check (atom kept ungated), so cite real ids to get protection, and never invent facts absent from the source. Note: the check is lexical (shared words), so a heavily paraphrased/normalized atom (e.g. expanding an acronym the source never spelled out) can be dropped even when truthful — keep some of the source's own wording in `content`, or leave `source_message_ids` empty if you must paraphrase far.

**Three types with scope routing:**
- **persona** (priority 50-100) → stored globally. Stable user attributes, preferences.
- **episodic** (priority 60-100) → stored per-project. Events, decisions, plans.
- **instruction** (priority 70-100) → stored globally. AI behavior rules.

**Filtering — skip these:**
- Greetings, filler, one-time requests
- AI tool outputs, error messages
- Anything already covered by existing memories (check with `tmem search <keyword>` if unsure)

If a session has no extractable memories, mark it done and move to the next.

### 4. Write atoms

Write the JSON array to a temp file to avoid shell escaping issues, then pipe it:

```bash
cat <<'ATOMS_EOF' | tmem write-l1 --session SESSION_ID
[{"content": "...", "type": "persona", "priority": 80, "scene_name": "...", "source_message_ids": ["<real-uuid-from-transcript>"], "metadata": {}}]
ATOMS_EOF
```

### 5. Verify and hint

```bash
tmem status
tmem changelog --last 10
```

After seeding, tell the user: **Next: use the memory-consolidate skill** to group atoms into scenes and synthesize persona.
