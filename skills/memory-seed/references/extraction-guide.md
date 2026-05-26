# Memory Extraction Guide

Detailed rules for extracting L1 memory atoms from Claude Code conversation logs.

## Extraction Principles

1. **Quality over quantity**: Skip trivial chatter, greetings, one-time tool requests.
2. **Self-contained**: Each memory must be understandable without conversation context.
3. **Merge related facts**: Combine strongly related or causal messages into one memory.
4. **Stable facts only**: Extract facts that persist beyond the current conversation.
5. **User-centric**: Focus on user attributes, not AI behavior or tool outputs.

## What NOT to Extract

- Greetings, pleasantries, filler ("hi", "thanks", "ok")
- One-time tool requests ("translate this", "format this code")
- Temporary/session-scoped instructions ("for this task, use X")
- AI self-descriptions or internal reasoning
- Raw tool outputs (file contents, search results, error messages)
- Duplicate information already captured in existing memories
- Pure emotional expressions without factual content

## MemoryRecord Schema

Each extracted memory must match this schema (from upstream `l1-writer.ts`):

```json
{
  "id": "m_{timestamp_ms}_{random_hex}",
  "content": "Complete, self-contained memory statement",
  "type": "persona|episodic|instruction",
  "priority": 50,
  "scene_name": "Brief scene description",
  "source_message_ids": ["uuid-1", "uuid-2"],
  "metadata": {},
  "timestamps": ["2025-05-25T10:00:00.000Z"],
  "createdAt": "2025-05-25T10:00:00.000Z",
  "updatedAt": "2025-05-25T10:00:00.000Z",
  "sessionKey": "claude-code:{session_id}",
  "sessionId": "{session_id}"
}
```

When extracting, provide at minimum: `content`, `type`, `priority`, `scene_name`, `source_message_ids`, `metadata`.
The writer auto-generates: `id`, `timestamps`, `createdAt`, `updatedAt`.

## Type-Specific Rules

### persona (priority 50-100)

**Definition**: Stable user attributes, preferences, skills, values, habits.

**Extraction pattern**: "User (name) prefers/is/likes/uses/works with..."

**Priority scoring**:
- 80-100: Health constraints, core identity, critical preferences (e.g., dietary restrictions, primary language)
- 50-70: General preferences, skills, tools used
- <50: Vague or uncertain — skip these

**Trigger signals in conversation**:
- "I like...", "I prefer...", "I always...", "I'm a..."
- "I use X for...", "my setup is...", "I work with..."

**Examples**:
```json
{"content": "User prefers dark mode across all IDEs and terminal emulators", "type": "persona", "priority": 80}
{"content": "User works primarily with TypeScript and Python", "type": "persona", "priority": 70}
{"content": "User is a backend developer at a fintech startup", "type": "persona", "priority": 85}
```

### episodic (priority 60-100)

**Definition**: Objective events, decisions, plans, outcomes with temporal context.

**Extraction pattern**: "User did X on [date/time] at [place/context]"

**Priority scoring**:
- 80-100: Major decisions, deployments, milestones
- 60-70: Routine completed tasks
- <60: Trivial events — skip these

**Time handling**:
- Derive timestamps from message timestamps when possible
- Include `activity_start_time` and `activity_end_time` in metadata (ISO 8601)
- Omit time fields if uncertain

**Examples**:
```json
{
  "content": "User deployed the API gateway to production on 2025-05-25",
  "type": "episodic",
  "priority": 85,
  "metadata": {"activity_start_time": "2025-05-25T11:00:00.000Z"}
}
{"content": "User decided to use PostgreSQL instead of MongoDB for the user service", "type": "episodic", "priority": 80}
{"content": "User completed the OAuth2 integration with Google SSO", "type": "episodic", "priority": 75}
```

### instruction (priority 70-100 or -1)

**Definition**: Long-term AI behavior rules, format preferences, constraints.

**Extraction pattern**: "User requires/wants AI to always/never..."

**Priority scoring**:
- -1: Absolute commands ("NEVER do X", "ALWAYS do Y" — strict global rules)
- 90-100: Core behavior rules
- 70-80: Important but flexible preferences
- <70: Temporary or session-scoped — skip these

**Trigger signals**:
- "From now on...", "Always...", "Never...", "Remember to..."
- "I want you to...", "When you respond...", "Make sure to..."

**Examples**:
```json
{"content": "User requires AI to always use uv run for Python execution, never call python directly", "type": "instruction", "priority": -1}
{"content": "User wants concise responses without unnecessary explanations", "type": "instruction", "priority": 90}
{"content": "User prefers code examples over long textual descriptions", "type": "instruction", "priority": 80}
```

## Scope Classification

Determines where memories are stored:

| Type | Scope | Storage |
|------|-------|---------|
| persona | Global | `~/.memory-tencentdb/global/` |
| instruction (general) | Global | `~/.memory-tencentdb/global/` |
| instruction (project-specific) | Project | `~/.memory-tencentdb/projects/{hash}/` |
| episodic | Project | `~/.memory-tencentdb/projects/{hash}/` |

**Project-specific instruction example**: "For this repo, always run tests before committing" → project scope.
**General instruction example**: "Always use TypeScript strict mode" → global scope.

## Scene Segmentation

When processing a conversation, group messages into scenes:

- A **scene** is a coherent topic/activity block within a conversation
- Scene boundaries: topic change, new goal, explicit redirection
- Name format: Brief descriptive phrase (e.g., "Plugin development setup", "Database migration planning")
- One conversation may have 1-5 scenes typically

## Deduplication

Before writing, check if similar memories already exist:

1. Search FTS5 for the key terms in the new memory
2. If a match with >80% content overlap:
   - **Same type + higher priority** → update existing
   - **Same type + adds new info** → merge into one record
   - **Exact duplicate** → skip
3. If no match → store as new

## Worked Example

**Conversation snippet**:
```
[user] 2025-05-25T10:00:00Z: Can you set up dark mode in my VS Code? I always use dark themes.
[assistant] 2025-05-25T10:01:00Z: I'll configure dark mode. Setting the theme to "One Dark Pro"...
[user] 2025-05-25T10:02:00Z: Perfect. Also, from now on, always use TypeScript strict mode when creating new projects.
[assistant] 2025-05-25T10:03:00Z: Noted, I'll use strict mode for all new TypeScript projects.
```

**Extracted memories**:
```json
[
  {
    "content": "User always uses dark themes in IDEs, currently using VS Code with One Dark Pro",
    "type": "persona",
    "priority": 75,
    "scene_name": "IDE configuration",
    "source_message_ids": ["msg-1", "msg-2"],
    "metadata": {}
  },
  {
    "content": "User requires AI to always enable TypeScript strict mode when creating new projects",
    "type": "instruction",
    "priority": 90,
    "scene_name": "IDE configuration",
    "source_message_ids": ["msg-3", "msg-4"],
    "metadata": {}
  }
]
```

**Not extracted**:
- The specific tool actions (setting theme) — too transient
- "Perfect" response — trivial acknowledgment
