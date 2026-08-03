# AUDIT — `tmem view`, the memory visualiser

**Surface audited:** `scripts/view/shell.html` (2 945 lines, zero dependencies), served by
`scripts/view/serve.js`, fed by `extract.js` → `transform.js`, typed by `contract.js`.
**Observed live** at `http://localhost:8891/?key=…` against the real store, snapshot
`s1-b41d81cf395452e7`, 2026-08-03 12:07. Screenshots taken headless at 1400px in both
`?theme=light` and `?theme=dark`.

**Mode: OVERHAUL.** The owner's verdict — *"bad ux and ui, i can't focus any, and can't see my
memory and dont know what that mean?"* — is a rejection of the direction, not the execution.
Recorded as direction from the owner; not inferred.

---

## 0. Root cause, stated once

**It was built as a diagnostic instrument for the plugin's author, and labelled as a tool for
the user to see their own memory.**

Everything below is a consequence of that one sentence. The page is an excellent instrument:
`contract.js` is a genuinely rigorous measurement contract, the `unmeasured ≠ zero` machinery is
better than most production telemetry, and the `Does the agent actually know me?` block asks
exactly the right question. But the reader it was written for is someone who already knows what
`byTierChars` is. The reader who opened it is someone who wanted to see their memory.

The fix is not more polish. It is a different first screen.

---

## 1. Tokens as built

Extracted from `shell.html:44–138`. These are the *actual* values, not what a doc claims.

### Surfaces and ink

| Role | Light | Dark | Note |
|---|---|---|---|
| `--surface-page` | `#f9f9f7` | `#0d0d0d` | page behind cards |
| `--surface-1` | `#fcfcfb` | `#1a1a19` | card / tile fill |
| `--ink-1` | `#0b0b0b` | `#ffffff` | primary text |
| `--ink-2` | `#52514e` | `#c3c2b7` | secondary text |
| `--ink-muted` | `#898781` | `#898781` | mode-invariant |
| `--grid` | `#e1e0d9` | `#2c2c2a` | table rules |
| `--baseline` | `#c3c2b7` | `#383835` | axis / hatch stroke |
| `--border` | `rgba(11,11,11,.10)` | `rgba(255,255,255,.10)` | alpha, not a hex |
| `--wash` | `rgba(11,11,11,.035)` | `rgba(255,255,255,.05)` | alpha, not a hex |

### Data colour

| Role | Light | Dark |
|---|---|---|
| `--series-1` … `-3` | `#2a78d6` `#eb6834` `#1baf7a` | `#3987e5` `#d95926` `#199e70` |
| `--seq-1` … `-3` | `#86b6ef` `#2a78d6` `#184f95` | identical (not re-stepped for dark) |
| `--status-good/warning/serious/critical` | `#0ca30c` `#fab219` `#ec835a` `#d03b3b` | identical except `--success-text` |
| `--success-text` | `#006300` | `#0ca30c` |
| `--dim-1` / `--dim-2` | `#c3c2b7` / `#898781` | `#383835` / `#898781` |

### Type, spacing, form

- `--font: system-ui, -apple-system, "Segoe UI", sans-serif`; `--mono: ui-monospace, …`.
  One family. No webfont, no CDN — deliberate and correct for a localhost tool.
- Type scale as built: 54 / 26 / 16 / 15 / 13.5 / 13 / 12.5 / 12 / 11.5 / 11 px. **Ten sizes,
  five of them within 1.5px of a neighbour.** That is the type-scale-discipline finding (F7).
- `--radius: 6px`, single value. Bars use a hand-written `4px` data-end (`shell.html:280`).
- Spacing is ad-hoc: `16px` card padding, `20px` wrap padding, and inline `margin-top` values of
  2/3/4/5/6/8/10/12/14/16/18px. No spacing token exists.
- Container `max-width: 1160px`.
- Shadow: none, except `box-shadow: inset 3px 0 0 …` used as a left severity rule, and
  `0 0 0 1px var(--border)` used as a hairline. No elevation system — appropriate.

### Palette verdict — it holds, reuse it

Run against the dataviz validator (`dataviz/scripts/validate_palette.js`):

```
light  #2a78d6,#eb6834,#1baf7a  → ALL CHECKS PASS
       WARN Contrast vs surface: #1baf7a is 2.74:1 — relief required
dark   #3987e5,#d95926,#199e70  → ALL CHECKS PASS (all ≥ 3:1)
```

CVD separation worst-adjacent ΔE 9.2 (deutan) light / 9.4 dark — above the 8 target. The
light-mode green WARN is not dismissable: it obliges visible labels or a table view, and the
existing shell does provide both. **Finding: keep this palette.** It is measured-good and
re-deriving one would spend the budget in the wrong place.

> Gap: the brief cited `node scripts/validate_palette.js` in this repo. **That file does not
> exist here.** The validator lives inside the bundled `dataviz` skill. The comment at
> `shell.html:33–34` points at a path that is not in the repo — a small doc rot worth fixing
> whenever `scripts/` is next touched (not by this design task).

---

## 2. Component inventory

Every component is defined once, in `shell.html`'s single `<style>` block (lines 40–500), and
rendered by hand-written template strings in the same file. There is no duplication of
definitions — design debt here is **low**. The debt is in *what they are asked to say*.

| Component | Defined | Instances observed | State |
|---|---|---|---|
| Top bar + wordmark | `.topbar`, `.brand` | 1, sticky | OK |
| Lens tabs | `.lens-tab` | 4 — **3 of them `disabled`** | F1 |
| Button | `.btn`, `.btn.is-on` | 5 (`Show table` ×3, `Dim undelivered`, `Theme`) | OK |
| Live-channel indicator | `.chan` + `.led` | 1 | OK |
| Change badge | `.changed-badge` | 0 at rest | OK |
| Card | `.card` | 4 | OK |
| Stat tile | `.tile` | 5 | F2, F3 |
| Hero figure | `.hero .fig` | 1 (`12,2 %`) | F3 |
| Stacked bar + rail | `.bar`, `.seg`, `.rail` | 3 | OK, well-built |
| Hatch fill (`unmeasured`) | `.hatch`, `.nm` | several | **Best thing on the page** |
| Legend | `.legend` | 3 | OK |
| Table view | `table.tbl` | 3, collapsed behind `Show table` | OK |
| Status pill | `.pill` + 5 modifiers | many | OK |
| Notice / callout | `.notice` + warn/critical/info | 4 | OK |
| Bullet row | `li.bullet` | 81 | F4 |
| Duty chip (editable claim) | `.duty` (dashed = a claim) | 81 | thoughtful; F5 |
| Review popover | `.review` | on demand | OK |
| Search form | `.qform` | 1 | OK |
| Code block | `pre.block` | on demand | OK |
| Skeleton | `.skel` | on load | OK |

**Icon family: none.** The page uses geometric CSS shapes (dots, squares, hatch swatches) and a
handful of literal glyphs. That is a legitimate zero-icon system and should be stated as the
choice, not left implicit.

No modal, no toast, no form validation, no destructive-action pattern — the surface is
read-only by design (`serve.js` exposes no mutating route).

---

## 3. IA and flows as they exist

```
tmem view  →  one page
             ├── top bar: Context | Signal (disabled) | Scenes (disabled) | Gaps (disabled)
             ├── Health strip — 5 tiles of system telemetry            ← opens here
             ├── "Does the agent actually know me?" — hero % + tier bar + 4 notices
             ├── Persona section tree — 81 bullets at full length
             └── Recall trace — type a prompt, see what would inject   ← below the fold
```

**Where the flow loses the target action.** There is no target action. The page asks nothing of
the reader and offers nothing to press except `Show table` and `Theme`. The one genuinely
actionable thing in the whole dataset — 23 stores that will silently give worse search results
until someone runs `tmem sync` — is computed, given `suggestion: "tmem sync"` in the payload
(`contract.js:815`), and then **rendered nowhere**, because the `Gaps` lens that would show it is
a disabled button.

The most useful screen is the recall trace, and it is last.

---

## 4. Dial reading of the surface as built

| Dial | As built | Reading |
|---|---|---|
| `variance` | **3** | Conventional dashboard chrome. The one non-conventional move — the hatch-fill "not measured" mark — is the good one. |
| `motion` | **1** | Zero transitions, zero keyframes, zero `prefers-reduced-motion` blocks — and the last is fine, because there is no motion to reduce. |
| `density` | **9** | Five tiles, a 5-segment stacked bar with a 5-item legend, four stacked notices, then 81 rows of 400–1 434-char prose. Measured: the first viewport at 1400×1000 carries **17 distinct numbers**. |

The redesign's dials are a stated delta from these, in `design-brief.md`.

---

## 5. Accessibility baseline

Measured on declared tokens, not sampled from pixels.

**Passes.**
- `--ink-1` on `--surface-1`: **19.17:1** light, **17.42:1** dark. `--ink-2` on `--surface-1`:
  **7.73:1** light, **9.72:1** dark. Both AA body, both modes.
- `--ink-on-warning` (`#0b0b0b` on `#fab219`): **10.73:1**. The one in-fill label pairing, and it
  is right.
- Visible focus exists and is one rule for everything: `outline: 2px solid var(--series-1);
  outline-offset: 2px` (`shell.html:203–205`).
- Colour never travels alone: every `.pill` carries a label, every `.legend` carries a value,
  every chart has a table twin behind `Show table`. This is done properly.
- `@media print, (forced-colors: active)` adds a `currentColor` outline to segments — a real
  forced-colors thought, which is rare.
- Reduced motion: trivially satisfied (no motion).
- Landmarks and `aria-labelledby` are present on every `<section>`; `aria-current="page"` on the
  active lens tab; `aria-pressed` on the dim toggle.

**Findings.**
- `--ink-muted #898781` on `--surface-1 #fcfcfb`: **3.50:1** — below AA (4.5:1) for body text, and
  **3.41:1** on `--surface-page #f9f9f7`, which is where most of it actually sits. Used at 11px
  for `.skel`, `.chan`, the rootdir path, and the `.nm` "not measured" label — i.e. the label on
  the one affordance the whole contract exists to protect. In dark (`#898781` on `#1a1a19`) it is
  **4.85:1** and passes. **Light mode is the failing side.** (F8)
- `.lens-tab[disabled]` renders in `--ink-muted` too — a 3.4:1 label on a control that also cannot
  be operated. Doubly invisible.
- Two more leads for the redesign's own token choices, measured on the built values:
  `--status-critical #d03b3b` on dark surface is **3.62:1** (large-text only, not body), and
  `--series-1 #2a78d6` on light surface is **4.30:1** (fine as a *mark*, not as text). Neither is
  a defect in the current page — it uses both as fills — but a rewrite that starts colouring
  sentences with them would introduce one.
- Minimum interactive height is 26px (`.btn { min-height: 26px }`), under the 32px desktop floor
  in the skill's surface table. (F9)
- Body text is 14px base with a great deal of 11px and 11.5px — under the 14px desktop floor for
  a large share of the page's actual words. (F9)

These are *declared-token* verdicts. Nothing here was sampled from a screenshot.

---

## 6. Findings

Severity: **blocker** = the product fails its stated purpose · **warning** = a user will be
misled or lost · **advisory** = craft.

| # | Sev | Finding | Observed |
|---|---|---|---|
| **F1** | blocker | **The memories are not on the page.** 5 542 L1 atoms and 219 scene blocks exist; the page renders the L3 persona and nothing else. The three lenses that would show them are `disabled` buttons reading "Not built yet". | `shell.html:514–516`; snapshot `totals.records = 5542`, `totals.scenes = 219` |
| **F2** | blocker | **No answer is asserted.** The page opens with five equal-weight tiles of system telemetry and no verdict. A person cannot learn "is my memory OK?" from it at any speed. | Live screenshot, first viewport |
| **F3** | blocker | **Numbers stand alone.** `37,3 %`, `39,1 %`, `12,2 %`, `219`, `5 542` are each presented as a figure with a technical gloss and no consequence and no action. `12,2 %` is the hero — a ratio, as the single largest thing on the page. | `shell.html:2238–2315`; `.hero .fig` at 54px |
| **F4** | blocker | **The vocabulary is the implementation's.** On screen, verbatim: `Vector coverage`, `Low-signal share`, `L1 atoms`, `Scene blocks`, `audit baseline 38,6 % · drift +0,5 pp (within ±2,0 pp)`, `duty class`, `always / conditional / reference`, `T0 session / T1 per turn / T2 on demand`, `not delivered`, `byTierChars`, `snapshot s1-b41d81cf395452e7`. The owner's own recorded requirement is *"UX flows must be end-user natural, not CLI-thinking-in-UI."* | `shell.html:551, 1890–1893, 2212–2315` |
| **F5** | warning | **The most actionable finding in the data is unrendered.** 23 stores have `l1_vec` present and empty; the gap carries `severity: critical` and `suggestion: "tmem sync"`. Nothing on the page shows it. | snapshot `gaps[]`, kind `vectors_missing`, n=23, severity critical |
| **F6** | warning | **The persona bullets are printed at source length.** 81 bullets, longest 1 434 chars, all expanded, no truncation, no summary-first. The tree is 2 300px of prose in the first scroll. The irony is exact: the page's own finding is that 11 bullets are too long to be delivered, and it delivers all of them to the human at full length. | Live screenshot; `persona.projection.totalChars = 38733` |
| **F7** | advisory | Ten type sizes, five of them within 1.5px of a neighbour (13.5/13/12.5/12/11.5/11). No spacing token; eleven distinct inline `margin-top` values. | `shell.html:153–165` and inline styles |
| **F8** | warning | `--ink-muted` fails AA in light mode at 3.1:1, used for 11px body text in six places. | tokens as built |
| **F9** | advisory | 26px control height and 11px body text sit under the desktop surface floors (32px / 14px). | `shell.html:200`, `.xsmall` |
| **F10** | advisory | `Show table` appears three times as the same label for three different tables; `Dim undelivered` is a control whose label only parses if you already know what "delivered" means. | `shell.html:523, 535, 572, 749` |
| **F11** | note, not a defect | **`unmeasured ≠ zero` is implemented correctly and beautifully** — one `.nm` mark, one `.hatch` fill, a three-way `Status`, and constructors in `contract.js` that make blending *inexpressible* rather than merely discouraged. The live page correctly says "238 records in 24 stores are ⧅ not measured — excluded from the ratio, not counted as 0 %". **This must survive the plain-language rewrite.** It is the single thing the redesign is most likely to break. | `contract.js:20–33, 95–113, 865–919`; `shell.html:301–338` |

---

## 7. Never changes silently

Changing any of these requires the owner's explicit direction, recorded in the brief.

- **Routes.** `/api/snapshot`, `/api/store/:slug/records`, `/api/persona`, `/api/recall`,
  `/api/export`, `/api/events` — frozen in `contract.js` ROUTES so serve.js and any client agree
  literally.
- **Query parameters.** `?key`, `?view`, `?static`, `?demo`, `?theme`, `?q`, `?slug`. `?static=1`
  and `?theme=` are load-bearing for deterministic screenshots and CI.
- **The API envelope** `{ok, schemaVersion, snapshotId, generatedAt, data, error}` and
  `SCHEMA_VERSION` (`2` since the scene-nav honesty work). A UI change must not require a schema
  bump — the bump to `2` was not one: it paid for four semantic contract changes (heat ladder
  50 → 4 buckets, two gap kinds removed, `SceneStats` gaining `unmeasured` semantics, new
  `Totals` fields).
- **The lens names** `Context`, `Signal`, `Scenes`, `Gaps` and their order — they are `?view=`
  values, i.e. URLs. *A rename is a route change.* The redesign proposes renaming them; that is
  therefore flagged in the brief as an owner decision with a compatibility note, not done
  quietly.
- **Snapshot id format** `s<SCHEMA_VERSION>-<16 hex>` — currently `s2-<16 hex>` — and its
  derivation. Shown in the UI as provenance; a bug
  report quotes it.
- **The three-way `Status`** (`ok` / `unmeasured` / `error`) and the `Coverage` shape. Non-
  negotiable at any layer, including copy.
- **`LOW_SIGNAL_UNION_CLASSES` and `LOW_SIGNAL_BASELINE`** — the headline metric's definition is
  pinned on purpose. A rewrite may rename what the user *reads*; it may not change what is
  *counted*.
- `tmem view` as the command, and the tool name in the wordmark.

Not on this list, and therefore free: layout, IA within a page, tile order, copy, type scale,
spacing, element ids and CSS class names (no test parses the DOM — verified against `test/`).

---

## 8. What the audit preserves into FORWARD

The preserve-set, carried into `design-brief.md` verbatim:

1. **The palette**, both modes — measured-good, reuse without change.
2. **The hatch / `.nm` "not measured" affordance** — F11. One mark, three-way status.
3. **The table twin behind every figure** — the accessibility floor already met.
4. **Zero dependencies, one file, no build step** — a constraint the implementation earns.
5. **The recall trace** — the page's best idea, currently last. It moves up.
6. **`contract.js` as the vocabulary's source of truth** — every renamed term in the brief maps
   back to a named typedef, and the mapping table is the deliverable that proves nothing was
   invented.
