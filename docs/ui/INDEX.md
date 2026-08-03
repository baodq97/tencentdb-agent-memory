# docs/ui — `tmem view` redesign

The user-facing design for the memory visualiser. Produced by `design-flow:ui-designer`,
AUDIT then FORWARD, against the live store on 2026-08-03 (snapshot `s1-b41d81cf395452e7`).

**Start here:** open [`prototype.html`](./prototype.html) in a browser. It needs nothing
installed and no server. 16 frames, real copy, real numbers, both light and dark.

| File | What it is |
|---|---|
| [`audit.md`](./audit.md) | The existing UI, reviewed before anything was changed: tokens as built, component inventory, IA, dial reading, accessibility baseline, 11 findings, and the never-changes-silently list. |
| [`design-brief.md`](./design-brief.md) | The design read, the affordances, the dial reasons, the vocabulary translation table, rejected defaults, gaps, and the candidate comparison with the recommendation. |
| [`tokens.json`](./tokens.json) | The palette, type, spacing and contrast pairs. Gate-clean. |
| [`screens/memory-health.md`](./screens/memory-health.md) | Flow diagram and the per-screen contract: primary action, states, copy notes, API bindings. |
| [`prototype.html`](./prototype.html) | **The deliverable.** |
| `.design-flow/preview/candidates/` | Three complete token files — A (chosen), B, C — all gate-clean, so the owner can still pick by eye. Local scratch from the design skill; git-ignored, not checked in. Only variant A survives here, as `tokens.json`. |

## Gates

```bash
SK=~/.claude/plugins/cache/govkit/design-flow/0.1.0/skills/ui-designer/scripts
node $SK/check_tokens.mjs    docs/ui/tokens.json
node $SK/check_prototype.mjs docs/ui/prototype.html docs/ui/tokens.json docs/ui/screens
```

Both exit 0.

## What needs a decision from the owner

1. **Language.** The UI is written in English. That is the designer's call, recorded in
   `design-brief.md` § Language, and it can be overturned.
2. **Pick a candidate.** A was chosen on a stated criterion because no human was present. B and
   C are complete and can be rendered side by side.
3. **Renaming the lens tabs is a route change.** `Context / Signal / Scenes / Gaps` are `?view=`
   values. The proposal keeps them as permanent aliases and changes only the labels — needs a yes.

## What is not here

Implementation. `scripts/view/shell.html` is untouched; this is design only.
