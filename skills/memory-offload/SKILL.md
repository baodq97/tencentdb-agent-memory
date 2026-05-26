---
name: memory-offload
description: Context Offload is a planned feature for compressing verbose tool logs within a session using Mermaid-canvas summaries. Currently not implemented in the local-only plugin. Use when the user asks about context compression, offloading tool output, or Mermaid canvas memory.
---

# Context Offload (Mermaid canvas)

**Status: Not yet implemented.** This is a planned feature from the upstream TencentDB-Agent-Memory design.

## Concept

Within-session compression that replaces verbose tool logs with a Mermaid graph. Long-term memory (L0→L3) survives **across** sessions; context offload compresses **within** a session.

## What it would do

- Offload bulky tool output (file reads, search results, stack traces) to `refs/*.md`
- Keep only a compact Mermaid canvas in context
- Agent reads full text on demand via `node_id` references

## Current alternative

The plugin currently handles cross-session memory only:
- **Auto-capture** stores turn content in FTS5 on every Stop
- **Recall** injects relevant memories on each UserPromptSubmit
- **Persona** provides stable user context

For within-session context management, rely on Claude Code's built-in compaction.

## Future implementation

If you want to add context offload:
1. Create a `PostToolUse` hook that intercepts tool output
2. Store verbose output in `~/.memory-tencentdb/context-offload/<session>/refs/`
3. Generate a compact Mermaid summary for injection
4. Use Claude agent (not external LLM) for summarization
