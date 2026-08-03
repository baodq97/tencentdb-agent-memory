# Design brief — `tmem view`, rebuilt as a memory health check

Companion to [`audit.md`](./audit.md) (read that first — this brief takes its preserve-set and
its never-changes-silently list as input) and [`screens/memory-health.md`](./screens/memory-health.md).
The deliverable is [`prototype.html`](./prototype.html).

**Mode: OVERHAUL**, on the owner's recorded verdict: *"bad ux and ui, i can't focus any, and
can't see my memory and dont know what that mean?"*

**Direction: a health/diagnostic dashboard rewritten in human language.** Chosen by the owner
over a memory-browser direction, before this design started. Not re-litigated here.

---

## The design read

> Reading this as: a **dashboard** for **the person whose memory this is — a bilingual senior
> engineer opening `tmem view` between coding sessions, not the plugin's author debugging it**,
> whose one job is **fixing the one thing that is quietly degrading their memory right now**, in
> a **plain-spoken, calm, reads-like-a-short-report-a-colleague-wrote** language, leaning **a
> named approximation, "plain report": system-ui plus the dataviz mark specs, no component
> framework, zero dependencies**.

Sources for each slot:

| Slot | Source |
|---|---|
| page kind | `scripts/view/serve.js` serves one HTML page over localhost; there is no multi-page app to design |
| audience | the owner's verdict, verbatim, plus the audit's root-cause finding — the built page addressed the author, not the owner |
| job | the brief's stated first-screen question: *"is my memory OK, and what should I do about it?"* answered in about five seconds |
| vibe | the owner's recorded requirement, quoted in the brief: *"UX flows must be end-user natural, not CLI-thinking-in-UI"* |
| system family | audit § 8 preserve-set item 4 — zero dependencies, one file, no build step. Adopting a component framework would break a constraint the implementation has already earned |

**ADR-01 — design system.** No official package. A named approximation ("plain report") built
from `system-ui` and the `dataviz` skill's mark specs, hand-written in one file. *Why:* the
surface is a localhost tool shipped inside an npm plugin with no bundler; adding React/shadcn/
Material would add a build step to a product whose selling point is that it has none. *Cost:*
every component is hand-maintained, and there is no third-party accessibility work to inherit —
which is why the contrast pairs are declared and gated rather than assumed. **One icon family:
none** — geometric CSS shapes plus four literal glyphs (`✓ ⚠ ⧅ →`), carried over from the audited
surface where it already worked.

## Language: **English**

**This is my decision, not a fact, and the owner may overturn it.** The plugin is published
publicly and its README and CHANGELOG are English; the owner is bilingual EN+VI. The Vietnamese
preview in the brief existed so the owner could pick a *direction*, not a language.

Consequences if it is overturned to Vietnamese: the verdict sentence and every problem headline
are the translation surface (about 40 strings); the layout absorbs Vietnamese fine — it is
15–20% longer than English and every headline in the prototype has a spare line. The one string
that must **not** be translated is `RecallResponse.injected`, the literal block handed to the
assistant, because it is the raw artefact and paraphrasing it defeats the screen.

Note: the prototype deliberately keeps Vietnamese *content* where the real store has it — the
persona bullets ("sửa ở gốc không sửa ở ngọn", "khá bất ổn") and the example prompt "tạo agent
riêng review change cái đi". The interface is English; the memories are whatever the owner said.

## Affordances — what the hands and eyes actually meet

Named before styling, because these outrank aesthetics.

- **A desktop browser next to a terminal.** The person got here by typing `tmem view` and will
  go back to that terminal to act. Body floor 14px, target floor 32px, pointer + keyboard.
- **The page cannot execute anything.** `serve.js` exposes no mutating route, by design. So
  every "action" is a **command to copy**, not a button that does the thing — the primary action
  on the first screen is `Copy command` beside a visible `tmem sync`, and the person pastes it
  into the terminal that is already open. Designing a button that pretended to run it would be a
  lie about the architecture.
- **The page re-renders underneath the reader.** SSE (`/api/events`) pushes a new snapshot
  whenever the store changes, which it does *while the person reads*, because their assistant is
  writing memories in the next window. This is why motion is 1 and why the audited surface's
  change badge is preserved: movement on this page must mean "your data changed", nothing else.
- **A path and a snapshot id are quoted into bug reports.** Both stay on screen in mono, at 14px,
  selectable. They are the only system strings that survive the rewrite, and they survive on
  purpose.
- **Long content, in two scripts.** Persona bullets run to 1 434 characters and mix English and
  Vietnamese mid-sentence. Every line clamp is a character count with a "show all", never a CSS
  ellipsis that hides how much was cut.

## The three dials

| Dial | Built | New | Why |
|---|---|---|---|
| `variance` | 3 | **4** | The audit found the built page's one unconventional move — the hatch "not measured" mark — is also its best. Keep the conventional dashboard skeleton and spend the single risk on **the verdict sentence replacing the hero number**: a dashboard that leads with a sentence instead of a figure is unusual enough to be the signature and boring enough to be trusted. |
| `motion` | 1 | **1** | Unchanged, and deliberately so. See the SSE affordance above: this page's only movement should be a data change. `prefers-reduced-motion` is satisfied by there being nothing to reduce. |
| `density` | 9 | **5** | Measured: the built first viewport carries 17 distinct numbers. The new one carries 3 problems, 3 totals and their 3 gaps. Not lower than 5, because a person with 51 stores is reading a portfolio, and marketing-airy spacing would push the third problem below the fold. |

## Signature element

**The verdict line** — "Your memory is working — 3 things need attention." — at 28px, the largest
type on the page, a full sentence with a verb, in the goodText/criticalText role.

It is the one place boldness is spent. Everything around it is quiet: 15px body, hairline
borders, one accent. A reviewer can point at it without being told, and it is what the audited
page's `12,2 %` hero occupied — same slot, opposite decision.

## Where the constraints landed

The three non-negotiables from the brief, and where each is enforced in the artifact.

**1. No number stands alone.** Every figure in the prototype sits inside a sentence.
`37,3 %` does not appear anywhere — it became *"23 projects can only find memories that use your
exact words · 3 327 memories there have no meaning-index · → `tmem sync`"*. The rule is
structural, not editorial: `.issue` is a grid of `severity rule / headline sentence + why /
command`, and there is no slot in it for a bare number.

**2. "Not measured" stays distinct from "zero".** Three enforcement points:

- **A separate row with a different verb.** On Health check, *"23 projects can only find
  memories that use your exact words"* (measured; 20 of them have an index file that exists and
  is empty — a real zero) is a **critical problem row**; *"24 projects have never been checked —
  which is not the same as scoring zero"* is a **hatched strip below the problems**, with its own
  screen. Different severity, different mark, different sentence.
- **The mark.** The 45° hatch swatch from the audited surface is preserved verbatim as the
  "unchecked" mark and appears on both the strip and the per-row tag. Colour is never the carrier.
- **The words say it outright.** The `problem-detail — not checked yet` frame contains the
  sentence *"Averaging them in as zeros would have made that figure read worse than the truth"* —
  the plain-language version of `contract.js:20–33`, on screen where a user reads it.

**3. Gaps sit beside totals.** The `.tot` component has no variant without a `.gapline`: the
total and its gap share one bordered box, at the same size, separated by a hairline, not a
footnote. "5 542 memories saved" is physically unable to render without "About 3 reach the
assistant each turn" underneath it.

## Vocabulary — the translation table

Source of truth: `scripts/view/contract.js`. `docs/domain/` does not exist (recorded as a gap
below), so every row cites the typedef or constant that defines the concept. **Nothing in the
right column is a concept that was not already in the left.**

| Implementation term | Defined at | The words a person reads | Why this wording |
|---|---|---|---|
| L1 record / atom | `L1Record`, `RecordRow` | **memory** | The product's own name. "Atom" is an internal layering term. |
| L2 scene block | `SceneFile`, `SceneStats` | **topic summary** | A scene groups memories about one thing and carries a summary; "topic" is what the grouping means to a person. |
| L3 persona | `PersonaSummary` | **what it knows about you** | Used as the nav label. "Persona" reads as a marketing avatar. |
| persona bullet | `PersonaBullet` | **a thing written about you** / on the never-list, **a rule** | Duty-dependent: an `always` bullet is a rule, a `reference` bullet is a fact. |
| vector / embedding coverage | `VectorCoverageStore`, `Coverage` | **meaning-index**; searching **by meaning** vs **exact words only** | "Semantic" is jargon; "by meaning" is what it does. Never rendered as a bare percentage. |
| FTS-only | `RecallHit.matchedBy: "fts"` | **exact words only** | Says what will and will not be found. |
| `Coverage.partial` / `unmeasuredRecords` | `contract.js:854` | **"leaves N projects out"**, always beside the figure | Preserves the caveat the type exists to force. |
| low-signal | `LOW_SIGNAL_CLASSES` | **clutter** — "saved by mistake" | An owner recognises clutter; nobody recognises "low signal". |
| `taskNotification` | `contract.js:214` | **a finish notice** | |
| `skillEcho` | `contract.js:216` | **a tool echo** | |
| `slashOrTag` | `contract.js:217` | **a slash command** | |
| `continuation` | `contract.js:218` | **just "ok"** | |
| `pasteDump` | `contract.js:222` | **cut off mid-sentence** | Names the damage, not the class. This is the largest class (1 735) and the most alarming when said plainly. |
| duty class | `DUTY_CLASSES` | **must always know** / **only when it fits** / **look up if asked** | Kept on a **dashed** chip, because the classification is a heuristic — see below. |
| injection tier `sessionStart` | `INJECTION_TIERS` | **arrives at the start of every session** | Grouped by *what happens to it*, which is the question. |
| injection tier `promptSummary` | " | **arrives when it fits the question** | |
| injection tier `onDemand` | " | **only if the assistant goes looking** | |
| injection tier `never` | " | **never reaches it** | |
| `droppedAlwaysDuties` | `PersonaProjection` | **"33 of the 47 rules you set as 'always apply' never reach the assistant"** | The contract already calls this "the headline number"; this is that sentence. |
| `Status: unmeasured` | `STATUS` | **not checked yet** | |
| `Status: error` | " | **could not be read** | |
| `Status: ok` with 0 | " | **a real zero** — stated in as many words on the empty screen | |
| write path `auto` | `WRITE_PATH.AUTO` | **saved in the background** | |
| write path `awaited` | `WRITE_PATH.AWAITED` | **saved on purpose** | |
| `scenesInvisibleInNav` | `Totals` | **never offered to the assistant** | |
| `staleHot` | `STALE_HOT` | **marked active, untouched for 90 days** | |
| `orphanScenes` / `danglingSceneNames` | `SceneStats` | **a summary nothing points at** / **points at a summary that is not there** | |
| heat 1–5 | `HEAT_BUCKETS` | **active this week / active / recent / historical** | Uses the bucket `label`s already in the contract, verbatim. |
| `HEAT_SCALE_MISMATCH` | `GAP_KIND` | **"the activity marker is never shown"** | |
| `snapshotId` | `SNAPSHOT_ID_SPEC` | **reading** — `reading s1-b41d81cf395452e7` | Kept as a literal string; it is quoted into bug reports. Example id taken under schema v1; live ids now read `s2-…`. |
| `Gap.suggestion` | `contract.js:815` | the command, shown in mono beside a **Copy command** button | |

**One thing kept from the audited surface on purpose: the dashed duty chip.** The dashed border
means "this is the tool's guess, not your label", and the built page's own copy says the
classification is a heuristic that "is wrong at the margins". The prototype keeps the dashed
outline and adds the sentence in the footnote. Removing the dash to tidy the design would turn a
guess into a claim.

## Rejected defaults

**The generic default for this brief.** For "redesign a developer tool's diagnostic dashboard in
plain language", the default output is: a dark-first surface, one saturated accent (indigo or
emerald), a 4-across KPI row of large numbers with green/red delta arrows, a donut or a radial
gauge for the coverage percentage, a card grid, and a health "score" out of 100. Type would be
Inter with tabular numerals; the hero would be the score.

Diffed against the plan:

| Default | What happened | Why |
|---|---|---|
| **A health score out of 100** | **Rejected.** Replaced by the verdict sentence. | A score is exactly the "number that stands alone" the first constraint bans, and it would have to blend measured with unmeasured stores to exist — which `Coverage` makes structurally impossible on purpose. The one design move that would have looked most "designed" is the one the domain forbids. |
| **A 4-across KPI row of big numbers** | **Rejected as the lead**, kept as a 3-across strip *below* the problems, each tile carrying its own gap line. | That row is the audited page's failure (F2, F3). Demoting it and making the gap non-optional is the fix. |
| **A donut / radial gauge for coverage** | **Rejected.** | `dataviz/references/anti-patterns.md` territory, and worse: a gauge cannot express "24 stores are excluded from this ratio". The hatch strip can. |
| **Dark-first** | **Rejected.** Light is the default, dark is selected per-role. | The audited surface follows the OS and the owner runs both. Neither mode is "the" design; both are declared and gated (`dark.<role>` pairs in `tokens.json`). |
| **One saturated accent (indigo/emerald)** | **Survived, but not by default.** | The accent is `#1f66c0`, a *darkened* step of the existing validated `--series-1`. The audit measured the built palette as passing every dataviz check in both modes; re-deriving one to look fresher would spend the budget on the one thing already proven right. Darkened only because the built value is 4.30:1 on the light surface — fine as a mark, short of AA as a text/button colour. |
| **Inter + tabular numerals everywhere** | **Rejected.** `system-ui`, proportional figures for display numbers, `tabular-nums` only in columns. | A webfont adds a network dependency to a zero-dependency localhost page. Tabular figures at 24px "look loose" (dataviz `marks-and-anatomy.md` § Figures), and there are no numeric columns on the first screen. |
| **Green/red delta arrows** | **Rejected.** | There is no previous period to compare against — the snapshot is a state, not a series. An arrow would be invented precision. |
| **Card grid** | **Partly survived.** Problems are a single ruled list, not cards; the supporting blocks are cards. | A grid of equal cards says "these are peers"; the whole point of the first screen is that one problem is first. |

## Signature-adjacent decisions worth naming

- **The problem list is a list, not a table and not cards.** Reading order is the design: rank
  1, 2, 3, then the unchecked strip. `screens-and-states.md`'s rule that structure must encode
  something true — the order is the fix order, which is real information.
- **`Try a prompt` is promoted from last to a top-level tab.** The audited page's best idea was
  below the fold. It answers the question people actually arrive with ("why didn't it remember
  X?"), and it is the only screen that shows the raw injected block, which is the one place a
  system string is the right answer.
- **Every screen has exactly one primary action.** Counted: Health check → copy `tmem sync`;
  Problem detail → copy the command; What it knows about you → *Shorten the longest one*; Your
  memories → Search; Trace a prompt → Trace it.

## Numbers in the prototype

Every figure is measured from the live store, snapshot `s1-b41d81cf395452e7`, 2026-08-03, via
`node scripts/cli.js view --snapshot --stdout`. Re-verified against the payload rather than taken
from the brief — two figures differ from the brief and the payload wins:

| Brief said | Measured | Where |
|---|---|---|
| 5 541 atoms | **5 542** | `totals.records` |
| 22 present-but-empty · 25 never built | **23 empty · 24 never built · 4 populated** | `totals.vectorStates` |
| 113 gaps | **113** — 89 measured (51 info, 18 warn, 20 critical) + 24 unmeasured | `totals.gapsBySeverity` + `unmeasuredGaps` |

**Numbers that are examples, not measurements** — flagged so nobody ships a placeholder as a spec:

- Everything on `health-check — all clear`, `health-check — empty`, `health-check — error`, and
  `what the agent knows about you — empty`. These states do not currently exist in the live store.
  The error strings (`EBUSY`, `ENOENT`, `SQLITE_NOTADB`) are real OS errors for the real failure
  modes, but no store is currently in them.
- `handed to the assistant 6 times` on the Your-memories rows, and `About 3 reach the assistant
  each turn` on the totals tile. **See the gaps below — the payload does not carry either.**
- The 41 search matches and the 12 recall hits on the trace screen. The *prompts* are real
  (`fix the recall budget bug`, `tạo agent riêng review change cái đi`, `push → create pr` are
  live records); the hit counts are plausible, not run.

## Gaps in the upstream

Recorded, not invented around.

1. **`docs/domain/` does not exist.** `contract.js` is standing in for it, and it is unusually
   good at the job — its typedefs carry definitions *and* the reasons behind them. But it is a
   code file: nothing stops a rename there from silently breaking this brief's mapping table.
   Worth promoting the vocabulary table into `docs/domain/` in a later pass.
2. **`docs/api/` does not exist**, so there is no RFC 9457 problem-type list to diff the error
   states against. Derived from `API_ERROR` and the three-way `Status` instead; the coverage
   table is at the bottom of `screens/memory-health.md`.
3. **The payload has no "how much memory reaches the agent per turn" field.** It is the single
   most important number on the first screen — the counterweight that stops "5 542 memories"
   winning an argument it should lose — and it is not in `Snapshot`. `PersonaProjection` covers
   the L3 side (`injectedChars`, `byTierChars`); nothing covers L1 recall. **This is the clearest
   implementation ask this design produces:** a `Totals.recallPerTurn` (or equivalent) measured
   the way `PersonaProjection` is, from the real recall path.
4. **`RecordRow` has no delivery count.** "handed to the assistant 6 times" is the row metadata
   that turns a list of memories into an answer to "is this one earning its place". It would need
   a counter the writer does not currently keep. Listed as a want, not a requirement.
5. **`scripts/validate_palette.js` does not exist in this repo**, though `shell.html:34` cites it.
   The validator lives in the bundled `dataviz` skill; the palette was validated there and passes
   in both modes. Doc rot to fix when `scripts/` is next touched — out of scope for this task.

## Carried forward from the audit

`docs/ui/` did not exist before this run, so nothing was overwritten. From the audit's
preserve-set (§ 8), what was **kept**:

1. **The palette** — reused, with one change: `--primary` darkened from `#2a78d6` to `#1f66c0`
   so it clears AA as text and as a button fill. Series/status roles unchanged.
2. **The hatch / "not measured" affordance** — kept as the only mark for `unmeasured`, on both
   the strip and the tags.
3. **The table twin behind every figure** — kept as a requirement in the screens file; the
   prototype's data is sparse enough to read directly, so no `Show table` control is drawn.
   *This is a judgment a reviewer should check.*
4. **Zero dependencies, one file, no build step** — ADR-01.
5. **The recall trace** — kept and promoted to a top-level screen.
6. **`contract.js` as the vocabulary's source of truth** — the mapping table above.

What was **replaced**: the five-tile telemetry strip as the opening (demoted and rewritten), the
`12,2 %` hero (replaced by the verdict sentence), the full-length persona bullet wall (clamped to
96 characters with show-all), the four lens tabs (renamed — see below), and the ten-size type
scale (five sizes).

## Requires the owner's explicit direction

From the audit's never-changes-silently list, the redesign touches exactly one item:

- **The lens names.** `Context` / `Signal` / `Scenes` / `Gaps` are `?view=` values, i.e. URLs.
  The prototype renames them to **Health / Your memories / What it knows about you / Try a
  prompt**, which is a route change. **Proposed, not done:** keep the old `?view=` values as
  permanent aliases (`?view=context` → the persona screen, `?view=gaps` → Health) so no existing
  link or script breaks, and change only the labels. Needs a yes.

Everything else on that list — routes, query parameters, the envelope, `SCHEMA_VERSION`, the
snapshot id format, the three-way `Status`, `LOW_SIGNAL_UNION_CLASSES`, the `tmem view` command —
is untouched by this design. (`SCHEMA_VERSION` has since moved `1` → `2`, and with it the id
prefix `s1-` → `s2-`, but for semantic contract changes in the scene-nav work, not for anything
in this design.)

## Out of scope

- Implementation. `scripts/` is not modified by this task.
- Any change to what is *measured*. The rewrite renames what a person reads; it does not move a
  threshold, a baseline, or a class membership.
- Mobile and print. The surface is a desktop browser beside a terminal; a narrow layout exists in
  the built CSS and was not redesigned.
- The `Signal` lens's content (per-store record statistics). It has no screen here — the audit
  found it unbuilt, and the direction the owner chose does not need it. Recorded so its absence
  is a decision rather than an omission.

## Pre-flight

Blockers — all pass:

- `check_tokens.mjs docs/ui/tokens.json` → **0 violations**.
- `check_prototype.mjs` → **0 violations**.
- Read cold in a browser: every frame screenshotted at 1360px in **both** light and dark
  (`prefers-color-scheme` and the `data-mode="dark"` stamp), and every frame measured for
  overflow — all 16 fit inside the 1280×800 device without clipping.
- Every error state offers at least one way forward: Health-check error → `Try again` +
  `Show the folder` ×2; Trace error → `Try again` + `Search exact words only` + `tmem sync`.
- Surface floors met and machine-checked: no `font-size` below 14px anywhere inside `<body>`
  (`check_prototype.mjs` step 4), every control `min-height: 32px`.
- Physical/platform affordances: the top bar — wordmark, path, nav, live indicator, theme — is on
  all 16 frames, not on one screen's body.
- One design system (ADR-01), one icon family (none/geometric), one brand accent, status colours
  kept separate.
- Exactly one primary action per screen. Counted above.
- `docs/api/` absent → the RFC 9457 blocker does not apply; derived errors and the absence are
  both recorded (gap 2).
- Screen and entity names: `docs/domain/` absent → every name traced to `contract.js` in the
  mapping table instead, and the absence recorded (gap 1).
- **Rejected defaults** section: non-empty.
- Every decision cites a source. `docs/ui/` did not predate this run.

Advisories — the judgment calls a reviewer should weigh:

- **One signature element.** The verdict line. Pointable-at without being told.
- **Screens read as real** — real numbers from a live snapshot, real Vietnamese in the persona
  rows, real OS error strings, 5 result rows including two clutter rows and one truncated one.
  Each screen earned its own shape: the problem list, the grouped persona list, the result rows
  and the trace panel are four different layouts, not one with different words.
- **The quality floor**: focus ring declared on every control (`.btn:focus-visible`); no motion,
  so reduced-motion is satisfied; nothing depends on hover.
- **Copy register**: active verbs, stable names through the flow ("Copy command" → the command
  is visible beside it), errors that direct rather than apologise ("Your memories are not
  affected. Nothing was written and nothing was lost.").
- **Dark mode**: all 24 declared pairs are AA-clean, dark included; hierarchy verified by eye in
  both modes on all 16 frames.
- **Not ticked, stated instead:** the audit's preserved "table twin behind every figure" is
  carried as a requirement in the screens file but is not drawn in the prototype, because none of
  the new screens contains a chart dense enough to need one. If the implementation adds a chart,
  it adds the table with it.

## The candidates

Three complete, gate-clean token files in `.design-flow/preview/candidates/`:

| | Direction | Dials (v/m/d) | The bet |
|---|---|---|---|
| **A** | **Plain report** *(chosen)* | 4 / 1 / 5 | The verdict is a sentence. Colour spent almost nowhere; the words carry the meaning. |
| B | Status board | 3 / 2 / 7 | Severity-led triage cards with filled chips and buttons. Fastest to scan; the loudest. |
| C | Ledger | 6 / 1 / 4 | One narrow paper column, ruled like a statement, mono figures, near-colourless. The only one that puts memories on the first screen as line items. |

**No human was present to pick, so I picked, on a criterion from the brief.** The criterion is
the owner's recorded requirement — *"UX flows must be end-user natural, not CLI-thinking-in-UI"*.
By that test:

- **B fails the brief on its own terms.** A severity-sorted board of chips and commands is what an
  ops tool looks like. It is the most efficient of the three and the most likely to draw the same
  verdict again.
- **C is the most interesting and the biggest risk.** The statement metaphor is genuinely a
  better frame for "what did my memory do for me", and it is the only candidate that shows
  memories on screen one. It loses because its density-4 single column pushes the third problem
  below the fold, and the first screen's whole job is to hold three problems and their totals at
  once. If the owner disagrees with that trade, C is the one to look at again — it is a complete
  token file, not a sketch.
- **A wins** because the verdict sentence answers the five-second question directly, and because
  its low colour budget leaves the hatch mark and the severity rules as the only coloured things
  on the page — which is exactly where the meaning is.

**The pick is still the owner's.** All three are gate-clean and can be rendered side by side with
`design-flow:view`.
