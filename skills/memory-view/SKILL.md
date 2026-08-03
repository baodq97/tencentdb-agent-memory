---
name: memory-view
description: Open the memory visualiser in the browser — a health check on the memory store: is it working, what is wrong, and what to run to fix it. Run manually via /memory-view.
disable-model-invocation: true
---

# Memory View

`tmem view` **is** the implementation. This skill only starts it, hands over the URL,
and reads the feedback back. Never reimplement a metric, a route or a second way in —
if this file and the CLI can disagree, trust the CLI and fix this file.

**User-triggered only.** The page renders raw auto-captured prompts from *every*
project the user has opened. Do not open it on your own initiative.

## 1. Start the server

```bash
tmem view                          # live, opens on the health check
tmem view --query "<a prompt>"     # opens on "Try a prompt", tracing that query
tmem view --static                 # pin the snapshot so numbers can't move mid-read
```

Run it with **`run_in_background: true`** — it is a long-running server and it must
survive the turn. Flags: `tmem view --help`.

It prints:

```
tmem view — live mode, pid 363161, /home/dev/.memory-tencentdb
snapshot s2-12f246b66c7e650b (175.6 ms)
Opens on "Try a prompt", tracing: how do I like tests written

Open this URL verbatim — the session key is required:
  http://localhost:45261/?key=0f2c8a17be5d43906c1e77aa2b4d8e51&view=trace&q=how+do+I+like+tests+written

Session dir: /home/dev/.memory-tencentdb/view
Stop with Ctrl-C, or: kill 363161   (auto-stops after 240m idle)
```

Give the user that URL **complete and verbatim**. The key gates every route: a
reconstructed `localhost:<port>` gets a 403, and localhost alone was never the privacy
boundary here. If you missed stdout, the same details are in
`~/.memory-tencentdb/view/server-info.json`.

## 2. End your turn

They look and click. You cannot see the page.

## 3. Next turn: read their feedback

```bash
tail -20 ~/.memory-tencentdb/view/events.jsonl
```

One JSON object per line — anything posted to `/api/events`, each line carrying `kind`,
its target, the `snapshotId` it was seen against, and `at`/`timestamp`:

```json
{"kind":"gap.ack","gapId":"vectors_missing:global","snapshotId":"s2-27bb076f40017b87","at":"2026-08-03T03:45:00.097Z","timestamp":1785728700}
```

Expect it to be thin or absent: the rebuilt screens read the live channel but post no
interactions today, so **what they typed in the terminal is the feedback** and this file
is at most a supplement. Don't infer silence from an empty file. Then act:
fix the store, re-consolidate, adjust the persona. Be honest about the boundary of
"live": the page updates within seconds, but you only act when your next turn runs.

## Why open it

It answers *"is my memory healthy, and what do I do about it?"* — a verdict first,
then the problems ranked, each one a sentence with its figure inside it and a command
that fixes it. The numbers that matter are computed by the **same functions the recall
hook uses**, so the page cannot flatter the system. Four screens, `?view=`:

- `health` — the verdict, the ranked problems, the totals (default)
- `memories` — search and read what was actually saved
- `about-you` — which standing rules reach the assistant, and which never do
- `trace` — try a prompt, see the literal block the assistant would receive

A real reading: 52 stores, 5 560 records, 219 scenes, 76 problems — of 47 always-apply
rules only 13 reach the assistant each session and 33 never do, and 23 projects have an
index that exists but is empty, so they silently fall back to keyword-only search while
passing any file-exists check.

That is the point. A screen reading "5 560 records" while the assistant receives three
lines per turn would win an argument it should lose, so **a total never renders without
its gap** — don't report one without the other either.

## Files

Session output lives in `~/.memory-tencentdb/view/` (`--root` moves it) — **never
inside a repo**, so running the visualiser can't leave an untracked directory behind.
`--snapshot` writes `snapshot-<id>.json` there and exits without serving, for a pinned
baseline or a scripted diff.
