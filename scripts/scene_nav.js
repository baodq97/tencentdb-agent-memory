#!/usr/bin/env node
/**
 * The `<scene-navigation>` block: rendering only, no I/O.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two callers need the same answer about the same block, from opposite ends:
 *
 *   - `memory_recall.buildSceneNav()` needs the TEXT to inject into a turn.
 *   - `view/transform.sceneNavVisibility()` needs the COUNT — how many scenes
 *     actually fit — to report `visibleInNav` / `invisibleInNav` and to raise the
 *     "written but never seen" gap.
 *
 * Until this file existed, the second was a hand copy of the first: the fill
 * loop, the sort, the `+2` newline-joiner allowance, the 80-char summary cut, the
 * emoji ladder, the header/footer/guide literals. Nothing forced them to agree,
 * and the divergence had already started — `memory_recall`'s ATOM loops changed
 * `break` to `continue` in the same branch that added the copy. When that fix
 * reaches the scene loop, a stale copy would keep reporting scenes as invisible
 * that the agent can see, and the gap built on it would fire on nothing. Sharing
 * the core makes that a one-line change in one place, which is the whole point.
 *
 * It could not simply be exported from memory_recall.js: transform.js is pure by
 * test (`view_transform.test.js` asserts memory_recall.js never enters
 * require.cache, and requiring it pulls in memory_store.js -> node:sqlite). So the
 * core lives here, in a module with no requires at all, and BOTH sides import it —
 * the same arrangement persona_projection.js already has with the projection.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * ---------------------------------
 * Here: rendering a list of scenes into a budgeted block. Not here: finding the
 * scenes (fs), deciding their order (`buildSceneNav` puts project scenes before
 * global ones so global drops first under budget — a recall policy, not a
 * rendering rule), or resolving the budget from config. Callers hand in an
 * ALREADY-ORDERED, ALREADY-NORMALISED list, so neither caller's row shape leaks
 * in here and the core cannot start special-casing one of them.
 */
"use strict";

/** Token→char factor shared with memory_recall.js and the persona budgets. */
const CHARS_PER_TOKEN = 4;

/**
 * Literal parts of the block. Exported because the view reports the budget
 * arithmetic these produce, and a second copy of the header string would put the
 * two modules' char accounting quietly out of step.
 */
const NAV = Object.freeze({
  HEADER: "<scene-navigation>",
  FOOTER: "</scene-navigation>",
  GUIDE: "Load a full scene on demand: `tmem scene <name>`.",
  SUMMARY_MAX_CHARS: 80,
  /** header + guide + footer are joined by 2 newlines before any line is added. */
  JOINER_CHARS: 2,
});

/**
 * Fire-emoji cue based on scene heat (visual priority for the agent).
 *
 * The ladder starts at 50 while the writer's heat scale is 1–5, so it renders
 * nothing for every scene in the real store — a known finding the view reports.
 * It is reproduced here EXACTLY, not improved: the ladder decides rendered line
 * length, so "fixing" it would silently change how many scenes fit the budget.
 * That change is R2 and deliberately not this one.
 */
function heatEmoji(heat) {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/** Word-boundary-preferring cut with an ellipsis. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

/**
 * One rendered nav line for one scene. Exported for tests and for anything that
 * needs to know what a scene costs without rendering the whole block.
 *
 * @param {{name: string, heat: number|string, summary: string}} scene
 */
function navLine(scene) {
  const heat = parseInt(scene && scene.heat, 10) || 0;
  const name = String((scene && scene.name) || "");
  const summary = truncate(String((scene && scene.summary) || "").trim(), NAV.SUMMARY_MAX_CHARS);
  return `- ${name} (heat=${heat}${heatEmoji(heat)})${summary ? " " + summary : ""}`;
}

/**
 * Render the block, filling top-down until the next line would overflow.
 *
 * The fill BREAKS rather than skipping: one oversized line hides every scene
 * behind it. That is current behaviour and is preserved verbatim by this
 * extraction — changing it is a behaviour change, and now it is a change to one
 * loop instead of two.
 *
 * @param {Array<{name: string, heat: number|string, summary: string}>} orderedScenes
 *   Already sorted by the caller's policy and already normalised: `name` carries
 *   NO `.md` extension. `name` was chosen over `filename` because it is what the
 *   block actually prints and what the agent types back (`tmem scene <name>`) —
 *   the extension is a storage detail of whoever read the directory, and the two
 *   callers disagreed about it (`listScenes` yields `filename`, the view yields a
 *   stripped `name`). Normalising at the boundary keeps that disagreement out of
 *   here.
 * @param {number} maxChars Budget for the whole block. <= 0 renders nothing.
 * @returns {{text: string, visibleCount: number, usedChars: number, totalCount: number}}
 *   `text` is "" when nothing renders — no budget, no scenes, or not even one
 *   line fitting. `usedChars` counts the header/guide/footer scaffolding even
 *   when `text` is "", because that is the budget arithmetic the view reports.
 */
function renderSceneNav(orderedScenes, maxChars) {
  const list = Array.isArray(orderedScenes) ? orderedScenes : [];
  const scaffold = NAV.HEADER.length + NAV.GUIDE.length + NAV.FOOTER.length + NAV.JOINER_CHARS;

  if (!maxChars || maxChars <= 0) {
    return { text: "", visibleCount: 0, usedChars: 0, totalCount: list.length };
  }

  let used = scaffold;
  const lines = [];
  for (const s of list) {
    const line = navLine(s);
    if (used + line.length + 1 > maxChars) break; // top-down fill; the tail drops first
    lines.push(line);
    used += line.length + 1;
  }

  return {
    text: lines.length
      ? `${NAV.HEADER}\n${NAV.GUIDE}\n${lines.join("\n")}\n${NAV.FOOTER}`
      : "",
    visibleCount: lines.length,
    usedChars: used,
    totalCount: list.length,
  };
}

module.exports = { CHARS_PER_TOKEN, NAV, heatEmoji, truncate, navLine, renderSceneNav };
