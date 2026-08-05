/**
 * Tiered persona projection.
 *
 * WHY: the persona document grew to ~37k chars / 78 bullets, but the injector
 * only ever took the first 5 non-heading lines and cut them at 400 chars — 1.1%
 * of the document, all of it from `## Identity`, ending mid-word. The sections
 * that actually govern behaviour (`Preferences`, `Working Style`,
 * `Standing Instructions`) received exactly 0% of the budget, while the project
 * inventory and certifications — pure reference material the agent can look up
 * on demand — received 100%. The projection was inverted.
 *
 * Compression cannot fix that: a budget of a few hundred chars spread over five
 * sections is a fraction of a MEDIAN bullet, and a standing instruction cut in
 * half is not a shorter instruction, it is a wrong one. So this module treats
 * persona as a DUTY-CYCLE + DELIVERY-CHANNEL problem instead:
 *
 *   tier 0 `always`      — injected once per session (SessionStart), generous.
 *   tier 1 `conditional` — per turn, selected by relevance to the prompt, plus a
 *                          small always-on insurance line in case context
 *                          compaction dropped tier 0.
 *   tier 2 `reference`   — never injected; read on demand.
 *
 * Classification is heuristic and deterministic (no LLM, no network). It biases
 * hard toward `reference`: a false `always` pollutes every session forever, a
 * false `reference` merely reproduces today's behaviour.
 *
 * Long term the consolidator is expected to write a synthesised `## Core`
 * section (a derived artifact, regenerated, never hand-edited). It does not
 * exist yet; when it appears, `prefersCore()` makes it tier 0 verbatim and the
 * computed projection steps aside.
 *
 * Everything here is pure: text in, projection out. Callers do the file I/O.
 * The per-bullet provenance in the return value is load-bearing — the memory
 * visualiser renders the used-vs-unused split from THIS function, so there must
 * never be a second implementation of the projection.
 */
"use strict";

const { significantTokens } = require("./grounding.js");
// Two shared budget values live in the leaf `constants.js` (which requires
// nothing, so this module's no-I/O guarantee is untouched) and are re-exported
// below: memory_auto_capture.js reads DEFAULT_TIER0_MAX_TOKENS on the Stop
// hook's path and must not load this file to get it. Their meaning is documented
// here, where the tier economics are.
const { CHARS_PER_TOKEN, DEFAULT_TIER0_MAX_TOKENS } = require("./constants.js");

// ── Budgets (chars; ~4 chars/token for mixed EN/VI) ──
//
// CHARS_PER_TOKEN is the ONE definition of the chars/token approximation. It was
// declared independently in three modules, each with a comment naming the other
// two, which is the drift hazard those comments were describing. Re-exported so
// memory_recall.js, scene_nav.js and the SessionStart hook share it.
//
// THE TIERS ARE PRICED DIFFERENTLY ON PURPOSE. Tier 0 is paid ONCE per session;
// tier 1 is paid EVERY TURN. So "~1200 tokens of persona" costs ~1200 tokens for
// the whole session, not per message — an order of magnitude cheaper than the
// same number spent on tier 1, and roughly the price of a single medium file
// read. Do not "harmonise" these two numbers: shrinking tier 0 to match tier 1
// is the change that mangled the persona core, and growing tier 1 to match tier
// 0 would multiply that cost by every turn in the session.
//
// Tier 0 was measured at 1200/240: it delivered 5 of 47 always-duty bullets and
// truncated 4 of those 5 — standing instructions cut before their operative
// clause ("Recommendations with trade-offs + best option…" at 224 of 798 chars),
// which reads as a different rule rather than a shorter one. That is what the
// `always` class exists to prevent, so the once-per-session budget was widened
// to carry whole rules instead of more fragments.
//
// Tier 0 is the only budget the user can set in TOKENS (`tmem persona-max-tokens`,
// which the SessionStart hook multiplies back by CHARS_PER_TOKEN), so tokens are
// the primitive here and chars are derived. Defining it the other way round
// forced a `Math.floor` on the way back to tokens, making the round trip lossy
// for any budget not divisible by 4 — this way it is exact by construction and
// there is nothing to guard.
// DEFAULT_TIER0_MAX_TOKENS = 1200 — ONCE PER SESSION (see above); declared in
// constants.js, re-exported below.
const DEFAULT_TIER0_MAX_CHARS = DEFAULT_TIER0_MAX_TOKENS * CHARS_PER_TOKEN; // 4800
const DEFAULT_TIER1_MAX_CHARS = 420;    // ~105 tok, EVERY TURN — economics unchanged
const DEFAULT_INSURANCE_MAX_CHARS = 180; // slice of tier 1 reserved for cover
const DEFAULT_BULLET_MAX_CHARS = 600;   // tier 0: ELIGIBILITY threshold — a longer bullet is
                                        // skipped, never truncated (see MIN_BULLET_CHARS note).
                                        // tier 1: still a truncation cap.
const MIN_BULLET_CHARS = 60;            // below this a bullet is noise, not a shorter bullet

// TIER 0 DELIVERS WHOLE BULLETS ONLY — it never truncates.
//
// The intermediate design kept a bullet if it retained at least half its source.
// That ratio was a proxy for the property actually wanted ("the operative clause
// survived"), and it does not hold: Standing Instructions #6 was delivered at
// 594 of 1145 chars (51,9%), which passed the ratio while cutting away its
// "**Amended for orchard-flow only**" carve-out — so the agent received a STRICTER
// rule than the user wrote. Clause position does not correlate with length, so
// no ratio can detect that. A partial standing instruction is not a shorter
// instruction, it is a different one, and being different is worse than being
// absent: an absent rule leaves the agent uninformed, a mangled one leaves it
// confidently wrong.
//
// So tier 0 has no partial-delivery path at all. DEFAULT_BULLET_MAX_CHARS stops
// being a truncation cap there and becomes an ELIGIBILITY threshold: a bullet
// longer than it can never be injected into the session preamble, which pushes
// the fix to the write side (see skills/memory-consolidate/SKILL.md: one rule
// per bullet, operative clause first). It is still a live truncation cap for
// tier 1, which is cover rather than contract and may legitimately cut.
const LEGACY_MAX_LINES = 5;             // today's behaviour, kept for fallback
const LEGACY_MAX_CHARS = 400;

const ELLIPSIS = "…";
const CORE_SECTION = "core";

// ── Duty-cycle heuristics ──

// Section name is the strongest prior we have: authors already sorted their own
// bullets by purpose when they chose a heading.
const SECTION_PRIORS = [
  [/\bcore\b/, "always"],
  [/preferen|style|voice|tone|communicat|habit/, "always"],
  [/instruction|standing|rule|policy|protocol|guardrail|mandate/, "conditional"],
  [/identity|environment|access|project|stack|inventory|background|tool|setup/, "reference"],
];

// Reference tells: a bullet that names WHERE something is or WHICH version it is
// describes the world, it does not ask the agent to behave differently.
const REFERENCE_SIGNALS = [
  /(?:^|\s)[~.]?\/[\w.-]+\/[\w.-]+/,          // filesystem paths
  /\bhttps?:\/\//i,                             // URLs
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,               // IPv4
  /\bv?\d+\.\d+(?:\.\d+)?\b/,                  // versions (Node 24.1, CUDA 12.6)
  /\b(?:github|gh|repo|repository|branch|org)\b/i,
  /\b(?:certifi|cert-exam|AZ-\d{3}|renew)/i,
  /\b\d+\s?(?:GB|MB|TB|G|h)\b/,
  /\((?:\/|~\/|gh |GitHub )/,                   // "(…/path…", "(gh handle)"
];

// Directive tells: the bullet issues an order. Orders are worth carrying.
const DIRECTIVE_SIGNALS = [
  /\bnever\b/i, /\balways\b/i, /\bmust\b/i, /\bdo not\b/i, /\bdon'?t\b/i,
  /\bonly (?:when|if|after|with)\b/i, /\brequired?\b/i, /\bprefers?\b/i,
  /\bkhông (?:được|bao giờ)\b/i, /\bphải\b/i, /\bluôn\b/i,
];

// Trigger tells: the bullet is gated on a SITUATION, so it belongs on the
// per-turn channel where the situation can be detected, not in every preamble.
//
// Deliberately NOT here: never / always / must. Those are the strongest markers
// of an UNCONDITIONAL rule — reading them as triggers inverts the whole point
// and buries the user's standing rules behind a lexical match. ("No AI
// attribution trailers in commits" gated on the prompt mentioning commits means
// trailers get added on every other turn.) They live in DIRECTIVE_SIGNALS and
// in UNCONDITIONAL_OPENERS instead.
const TRIGGER_SIGNALS = [
  /^\*{0,2}(?:when|whenever|if|before|after|once|for|during|on)\b/i,
  /\bwhen (?:he|she|they|you|the user|told|asked|verifying|a |an |it )/i,
  /\bkhi\b/i, /\bnếu\b/i,
  /\b(?:invokable|on demand|on request)\b/i,
];

// A situational clause OPENS the bullet: "When verifying…", "Debugging config…".
const LEADING_SITUATION_RE =
  /^\*{0,2}(?:when|whenever|if|unless|before|after|while|during|once|upon|khi|nếu|for the|\p{L}+ing\b)/iu;

// A situational clause SCOPES the rule to a bounded event: "before any rename",
// "before porting/mining", "BEFORE a work window". The determiner or gerund is
// what makes it an occasion. "before non-trivial code" has neither — it names
// the normal course of work, so it stays unconditional.
const SITUATION_SCOPE_RE =
  /\b(?:before|after|when|while|during|once)\s+(?:any|a|an|each|the|\p{L}+ing\b)/iu;

// The bullet OPENS with a deontic: it states the rule itself, unconditionally.
const UNCONDITIONAL_OPENERS =
  /^\*{0,2}(?:never|always|no\s|not\s|must|do not|don'?t|all\s|every\s|each\s|luôn|không bao giờ)/i;

// A label that is a full clause ("An invoked skill is a GATE", "Delegated agents
// get the CITE-OR-MARK contract") asserts a universal fact; the "when…" that
// follows is elaboration, not a gate. A label that is a bare noun phrase
// ("Staging/gateway DB migrations") merely names the domain the rule applies to.
const LABEL_IS_CLAUSE_RE = /\b(?:is|are|was|were|gets?|has|have|means|applies|must)\b/i;

// Universal quantification anywhere in the bullet: "every load-bearing fact",
// "Read each folder", "Expand every acronym".
const UNIVERSAL_RE = /\b(?:every|all|each)\b/i;

// Self-declared default posture — unconditional by its own wording.
const DEFAULT_POSTURE_RE = /\bdefault posture\b|\bby default\b/i;

// Insurance tells: the handful of items whose loss is most visible to the user
// (language, register, attribution) get a per-turn cover line in case the
// session preamble was compacted away.
const INSURANCE_SIGNALS = [
  /\b(?:vietnamese|tiếng việt|bilingual|english|ngôn ngữ|language)\b/i,
  /\b(?:concise|direct|terse|brief|ngắn gọn)\b/i,
  /\battribution\b/i,
];

// Real bullets are overwhelmingly written as `**Label**: body`, so a trigger
// that gates the bullet still sits mid-string. Strip the label before asking
// whether the bullet OPENS with a trigger.
const LABEL_PREFIX_RE = /^\*{0,2}[^:*\n]{0,60}\*{0,2}:\s+/;

function stripLabel(text) {
  return text.replace(LABEL_PREFIX_RE, "");
}

// The clause carrying the rule itself: everything before the first sentence
// break, semicolon or em-dash aside.
function firstClause(text) {
  return text.split(/(?:[.;]\s|\s—\s)/)[0] || text;
}

function indexOfMatch(re, text) {
  const m = re.exec(text);
  return m ? m.index : -1;
}

// Earliest position at which any of `patterns` matches, or -1.
function firstIndexOf(text, patterns) {
  let best = -1;
  for (const re of patterns) {
    const i = indexOfMatch(re, text);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

function labelOf(text) {
  const m = LABEL_PREFIX_RE.exec(text);
  return m ? m[0].replace(/[*:\s]+$/, "").replace(/^\*+/, "") : "";
}

// Function words that survive grounding.significantTokens but carry no topic.
// A Vietnamese negation particle matching a bullet is not a relevance signal,
// and the persona is small enough that one such hit dominates a short query.
const EXTRA_STOPWORDS = new Set([
  "không", "cần", "nên", "phải", "chỉ", "vì", "để", "làm", "nào", "gì",
  "sao", "hay", "hoặc", "rất", "nữa", "thêm", "vào", "ra", "lại", "đi",
  "not", "first", "only", "before", "after", "then", "than", "per", "one",
  "his", "her", "its", "our", "you", "how", "why", "who", "can", "may",
]);

// Above this document-frequency share, a token is corpus glue, not a topic.
const COMMON_DF_RATIO = 0.25;

function countSignals(text, patterns) {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n++;
  return n;
}

function normalizeSectionName(name) {
  return String(name || "").normalize("NFKC").toLowerCase();
}

function sectionPrior(sectionName) {
  const name = normalizeSectionName(sectionName);
  for (const [re, duty] of SECTION_PRIORS) if (re.test(name)) return duty;
  return "reference"; // unknown heading → safest tier
}

/**
 * Duty class for one bullet. Deterministic; section prior + evidence overrides.
 */
function classifyDuty(bulletText, sectionName) {
  const text = String(bulletText || "").normalize("NFKC");
  if (!text.trim()) return "reference";

  const prior = sectionPrior(sectionName);
  const refScore = countSignals(text, REFERENCE_SIGNALS);
  const directive = countSignals(text, DIRECTIVE_SIGNALS);
  const trigger = countSignals(text, TRIGGER_SIGNALS);

  if (prior === "always") {
    // Two independent reference tells outweigh the heading: an author filing an
    // inventory item under Preferences is still filing an inventory item.
    if (refScore >= 2 && directive === 0) return "reference";
    // Only a LEADING trigger demotes. A trigger deep inside a preference is
    // usually illustration ("…e.g. when he pushes back…"), not a gate.
    if (TRIGGER_SIGNALS[0].test(stripLabel(text.trim()))) return "conditional";
    return "always";
  }

  if (prior === "conditional") {
    if (refScore >= 3 && directive === 0 && trigger === 0) return "reference";

    // A section of standing rules is NOT a section of conditional rules. Only a
    // situation that LEADS the rule makes it situational; a bare never/always/
    // must, a universal quantifier, or a self-declared default posture makes it
    // unconditional and it belongs in the session preamble.
    const trimmed = text.trim();
    const label = labelOf(trimmed);
    const body = stripLabel(trimmed);

    // Checked first: a label that asserts a universal fact governs the bullet
    // even when the body then opens with "when …".
    if (label && LABEL_IS_CLAUSE_RE.test(label)) return "always";
    if (LEADING_SITUATION_RE.test(label || trimmed)) return "conditional";
    // Scope only counts in the rule's OWN clause — "verify before claiming
    // done" four sentences into a bullet that opens "No AI attribution trailers
    // in commits" does not make the bullet situational — AND only when nothing
    // unconditional came first. A scope phrase that TRAILS a deontic or a
    // universal is qualification, not a gate: "Read each folder AGENTS.md
    // before editing" still applies to every folder.
    const lead = firstClause(trimmed);
    const scopeAt = indexOfMatch(SITUATION_SCOPE_RE, lead);
    if (scopeAt >= 0) {
      const unconditionalAt = firstIndexOf(lead, [
        DEFAULT_POSTURE_RE,
        UNCONDITIONAL_OPENERS,
        ...(label ? [] : [UNIVERSAL_RE]), // a domain label keeps its scope (see below)
      ]);
      if (unconditionalAt < 0 || unconditionalAt > scopeAt) return "conditional";
      return "always";
    }

    if (DEFAULT_POSTURE_RE.test(trimmed)) return "always";
    if (UNCONDITIONAL_OPENERS.test(trimmed)) return "always";
    // A bare noun-phrase label names the domain the rule is scoped to ("KG
    // foundation:", "Technical-review deliverables:"), so the rule only applies
    // inside that domain — even when it is worded with a "never".
    if (label) return "conditional";
    // Universal quantification with no domain label: the rule covers everything
    // it could apply to ("Read each folder AGENTS.md", "Expand every acronym").
    if (UNIVERSAL_RE.test(trimmed)) return "always";
    return "conditional";
  }

  // prior === "reference": promote only on unambiguous instruction with no
  // competing reference payload. This is where false positives are cheapest to
  // avoid, so the bar is deliberately high.
  // Exception: language/register. Which language to answer in governs EVERY
  // turn, so it is always-class wherever the author happened to file it —
  // getting it wrong is the single most visible persona failure.
  if (directive >= 1 && countSignals(text, INSURANCE_SIGNALS) >= 1 && refScore === 0) return "always";
  if (directive >= 1 && trigger >= 1 && refScore === 0) return "conditional";
  return "reference";
}

// ── Parsing ──

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;

/**
 * Parse persona markdown into
 * `[{name, bullets:[{text, chars, index, lineNo}]}]`.
 *
 * Tolerates: empty input, CRLF, no headings at all, prose before the first
 * heading, `-`/`*`/`+` bullets, and multi-line bullets (indented continuation
 * lines belong to the bullet above). Content outside any `##` heading lands in
 * a section whose name is "" so nothing is silently dropped.
 *
 * `lineNo` is 1-based and points at the line the bullet OPENS on (its `- `
 * marker), not at any continuation line. Recorded here because this loop is the
 * only place that knows it: consumers were re-deriving line numbers by mirroring
 * this block grammar, and a mirror that disagrees on one bullet loses the line
 * numbers for all of them. Line numbers are counted after CRLF normalisation, so
 * the same document parses identically whatever its line endings.
 */
function parsePersona(text) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const sections = [];
  let current = null;
  let pending = null; // open bullet accumulating continuation lines
  let pendingLine = 0; // 1-based line the open bullet started on

  const openSection = (name) => {
    current = { name, bullets: [] };
    sections.push(current);
    pending = null;
  };
  const flush = () => {
    if (!pending) return;
    const body = pending.join("\n").replace(/\s+/g, " ").trim();
    const lineNo = pendingLine;
    pending = null;
    if (!body) return;
    if (!current) openSection("");
    current.bullets.push({
      text: body,
      chars: body.length,
      index: current.bullets.length,
      lineNo,
    });
  };

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      // A single `#` is the document title, not a section — the real persona
      // opens with "# User Persona" above the first "## Identity".
      if (heading[1].length >= 2) openSection(heading[2].trim());
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flush();
      if (!current) openSection("");
      pending = [bullet[2]];
      pendingLine = lineNo;
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    // Indented non-bullet line continues the open bullet; anything else is
    // free prose, which we treat as its own bullet so legacy personas that
    // never used lists still project.
    if (pending && /^\s+/.test(line)) pending.push(line.trim());
    else { flush(); pending = [line.trim()]; pendingLine = lineNo; }
  }
  flush();

  return sections.filter((s) => s.bullets.length > 0 || s.name);
}

/**
 * Attach a duty class to every bullet, without mutating the input. Callers that
 * need the full used/unused picture (the visualiser) annotate once and pass the
 * result to both projections, so classification happens exactly once.
 *
 * COST: ~10,3 ms cold for 81 bullets on the real persona — the single largest
 * item on the per-turn path, since projectTier1 re-annotates every turn in a
 * fresh hook process. Pre-annotating and passing the result in avoids it. See
 * the cost note on buildIdf for the measured sidecar-cache option and why it
 * was deferred.
 */
function annotate(sections) {
  return (sections || []).map((section) => ({
    ...section,
    bullets: (section.bullets || []).map((b) => ({
      ...b,
      duty: b.duty || classifyDuty(b.text, section.name),
    })),
  }));
}

function dutyCounts(sections) {
  const counts = { always: 0, conditional: 0, reference: 0 };
  for (const s of annotate(sections)) for (const b of s.bullets) counts[b.duty]++;
  return counts;
}

/** True when the consolidator has written a synthesised `## Core` section. */
function prefersCore(sections) {
  return (sections || []).some(
    (s) => normalizeSectionName(s.name) === CORE_SECTION && (s.bullets || []).length > 0
  );
}

function coreSection(sections) {
  return (sections || []).find((s) => normalizeSectionName(s.name) === CORE_SECTION) || null;
}

// ── Truncation ──

/**
 * Remove an unmatched `**` by DELETING the marker, not by cutting back to it.
 * Cutting back throws away the text after the opener, and when the opener sits
 * at index 0 it throws away everything — which is how the old repair ended up
 * falling through to a raw slice that restored the very marker it removed.
 * Deleting keeps the words and can only shorten the result.
 */
function dropDanglingBold(text) {
  let out = text;
  for (;;) {
    const marks = out.match(/\*\*/g);
    if (!marks || marks.length % 2 === 0) return out;
    const i = out.lastIndexOf("**");
    out = out.slice(0, i) + out.slice(i + 2);
  }
}

/**
 * Cut at a word boundary, never mid-word, and never leaving an unbalanced `**`
 * (a dangling bold opener would swallow the rest of the injected block when the
 * host renders markdown — in tier 0 that is the whole session preamble).
 * Returns empty text only when nothing can be represented safely; callers treat
 * that as "skip this bullet".
 */
function truncateAtWord(text, maxChars) {
  const src = String(text || "");
  if (maxChars <= 0) return { text: "", truncated: true };
  if (src.length <= maxChars) return { text: src, truncated: false };

  const room = maxChars - ELLIPSIS.length;
  if (room <= 0) return { text: ELLIPSIS.slice(0, maxChars), truncated: true };

  let cut = src.slice(0, room);
  const boundary = cut.search(/\s+\S*$/u);
  // No whitespace at all means a single token longer than the cap; a hard cut
  // is the only option left, and it is still better than dropping the bullet.
  if (boundary > 0) cut = cut.slice(0, boundary);
  cut = cut.replace(/\s+$/u, "");

  cut = dropDanglingBold(cut).replace(/\s+$/u, "");
  cut = cut.replace(/[,;:–—-]$/u, "").replace(/\s+$/u, "");

  if (!cut) {
    // Word-boundary cutting left nothing (a single over-long token, possibly a
    // bold label). Fall back to a hard cut — but repair it too, so the escape
    // can never reintroduce the unbalanced marker.
    cut = dropDanglingBold(src.slice(0, room)).replace(/\s+$/u, "");
    if (!cut) return { text: "", truncated: true };
  }
  return { text: cut + ELLIPSIS, truncated: true };
}

const lineCost = (t) => t.length + 3;            // "- " + text + "\n"
const headerCost = (name) => (name ? name.length + 4 : 0); // "## " + name + "\n"

function renderGroups(groups) {
  const out = [];
  for (const g of groups) {
    if (!g.lines.length) continue;
    if (g.name) out.push(`## ${g.name}`);
    for (const l of g.lines) out.push(`- ${l}`);
  }
  return out.join("\n");
}

function emptyProjection(budgetChars) {
  return { text: "", bullets: [], usedChars: 0, budgetChars };
}

// ── Tier 0: session preamble ──

/**
 * Project the `always` class for the session preamble.
 *
 * Round-robin across sections so a large section cannot monopolise the budget,
 * with the first round reserving an equal slice per section so EVERY section
 * that has always-class content is represented even at small budgets.
 *
 * If a `## Core` section exists it wins outright: it is a synthesised, curated
 * artifact and second-guessing it with heuristics would defeat its purpose.
 */
function projectTier0(sections, options = {}) {
  const budgetChars = Math.max(0, options.maxChars ?? DEFAULT_TIER0_MAX_CHARS);
  const bulletMax = Math.max(MIN_BULLET_CHARS, options.bulletMaxChars ?? DEFAULT_BULLET_MAX_CHARS);
  const annotated = annotate(sections);
  if (!annotated.length || budgetChars === 0) return emptyProjection(budgetChars);

  const useCore = prefersCore(annotated);
  const source = useCore ? [coreSection(annotated)] : annotated;
  // Core is trusted verbatim, so the only cap it gets is the overall budget.
  const perBulletCap = useCore ? budgetChars : bulletMax;

  const groups = source.map((s) => ({
    name: s.name,
    bullets: useCore ? s.bullets : s.bullets.filter((b) => b.duty === "always"),
    lines: [],
    cursor: 0,
    open: true,
  }));
  const active = groups.filter((g) => g.bullets.length > 0);
  if (!active.length) return emptyProjection(budgetChars);

  const chosen = [];
  let used = 0;

  const reservedHeaders = active.reduce((n, g) => n + headerCost(g.name), 0);
  const firstRoundCap = Math.min(
    perBulletCap,
    Math.max(MIN_BULLET_CHARS, Math.floor((budgetChars - reservedHeaders) / active.length) - 3)
  );

  for (let round = 0; ; round++) {
    let progressed = false;
    const roundCap = round === 0 ? firstRoundCap : perBulletCap;

    for (const g of active) {
      if (!g.open) continue;
      // One ACCEPTED line per group per round. The inner loop only ever runs
      // again after a bullet was rejected as too long to deliver whole, and the
      // cursor always advances when it does, so this terminates.
      while (g.cursor < g.bullets.length) {
        const bullet = g.bullets[g.cursor];
        const overhead = g.lines.length === 0 ? headerCost(g.name) : 0;
        const available = budgetChars - used - overhead - 3;
        if (available < MIN_BULLET_CHARS) { g.open = false; break; }

        const cap = Math.min(roundCap, available);
        const text = bullet.text;

        if (text.length > cap) {
          // Round 0's cap is an equal-share RESERVATION, not the real ceiling.
          // A bullet that only fails against the reservation gets retried next
          // round at the full per-bullet cap instead of being lost.
          if (cap < perBulletCap && available > roundCap) break;
          // Otherwise the budget itself is the limit, and it only shrinks from
          // here — so skip this bullet and let a shorter one behind it arrive
          // whole rather than spending the tail on a fragment of this one.
          g.cursor++;
          continue;
        }

        used += overhead + lineCost(text);
        g.lines.push(text);
        g.cursor++;
        progressed = true;
        chosen.push({
          sectionName: g.name,
          index: bullet.index,
          duty: useCore ? "always" : bullet.duty,
          sourceChars: bullet.chars,
          injectedChars: text.length,
          // Structurally false now: tier 0 delivers whole bullets only. Kept in
          // the shape so consumers that zip tier-0 and tier-1 provenance (the
          // visualiser) need no special case.
          truncated: false,
        });
        break;
      }
    }
    if (!progressed) break;
  }

  // Selection happens round-robin but rendering is grouped by section; sort the
  // provenance list into rendered order so consumers can zip the two safely.
  const order = new Map(groups.map((g, i) => [g.name, i]));
  chosen.sort((a, b) => order.get(a.sectionName) - order.get(b.sectionName) || a.index - b.index);

  const text = renderGroups(groups);
  return { text, bullets: chosen, usedChars: text.length, budgetChars };
}

// ── Tier 1: per-turn ──

/**
 * Document frequency over the persona's own bullets. Using the persona as its
 * own corpus keeps this pure and deterministic (no external idf table) while
 * still separating a discriminating token like "pytest" (1 bullet) from a
 * ubiquitous one like "verify" (many) — plain overlap counts rank them equally
 * and pick the wrong bullet.
 *
 * Returns the per-bullet token sets alongside the table: tokenising all 81
 * bullets is the expensive half (~4,6 ms cold on the real persona) and
 * relevanceScore would otherwise redo it for every candidate.
 *
 * COST NOTE — this and `annotate` are the two hot spots of the per-turn path:
 * measured cold (a hook is a fresh process every turn, so JIT-warm numbers never
 * happen in production) on a 39 090-char / 81-bullet persona, projectTier1 is
 * ~17,5 ms, of which annotate/classifyDuty is ~10,3 ms and buildIdf ~7,1 ms;
 * only ~0,7 ms is query-dependent. Both are pure functions of persona.md, so a
 * sidecar cache keyed on its mtime+size would replace ~17,5 ms with ~1,4 ms
 * (prototyped: 34,8 KB, 0,90 ms to write, 1,43 ms to read cold), and SessionStart
 * already does the parse+annotate that would populate it. Deliberately NOT done:
 * a stale sidecar means acting on the wrong duty classification, which trades a
 * correctness failure for latency. Read it before optimising this again.
 */
function buildIdf(bullets) {
  const df = new Map();
  const tokens = new Map(); // bullet → its significant-token Set
  for (const b of bullets) {
    const set = new Set(significantTokens(b.text));
    tokens.set(b, set);
    for (const t of set) {
      if (EXTRA_STOPWORDS.has(t)) continue;
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const n = Math.max(1, bullets.length);
  const idf = new Map();
  for (const [t, c] of df) {
    // A token in a quarter of the persona discriminates nothing; zero-weighting
    // it here is a corpus-derived stoplist, so it works for any language the
    // store happens to contain rather than only the ones we hard-coded.
    idf.set(t, c / n > COMMON_DF_RATIO ? 0 : Math.log(1 + n / c));
  }
  return { idf, tokens };
}

/**
 * Weighted share of the query's persona-relevant mass covered by the bullet.
 * Unicode-aware via grounding.significantTokens (NFKC + \p{L}\p{N}); an ASCII
 * \w class would strip Vietnamese diacritics and silently kill recall on half
 * the store — the same bug toFtsQuery() had to fix in memory_store.js.
 * Query tokens absent from the persona are ignored rather than counted as
 * misses, otherwise a long prompt would push every score under any threshold.
 *
 * `bulletTokens` is an optional precomputed token Set for `bulletText` (buildIdf
 * already built one for every bullet). Passing it is a pure saving — the set is
 * identical to the one computed here — so scores cannot change.
 */
function relevanceScore(bulletText, qTokens, idf, bulletTokens) {
  if (!qTokens || !qTokens.size) return 0;
  const tokens = bulletTokens || new Set(significantTokens(bulletText));
  if (!tokens.size) return 0;
  let hit = 0;
  let total = 0;
  for (const t of qTokens) {
    const w = idf ? idf.get(t) : 1;
    if (!w) continue; // never appears in the persona, or appears everywhere
    total += w;
    if (tokens.has(t)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

function insuranceScore(bulletText) {
  return countSignals(bulletText, INSURANCE_SIGNALS);
}

// ── Project scope (tier 1 only) ──
//
// persona.md is ONE GLOBAL document while L1 and L2 are per project, so a
// `conditional` bullet written for one repo arrives as a standing rule in every
// other repo. Measured: the prompt "run the eval suite and report numbers"
// selected a rule about `tools/kg.py` — a file that exists only in a KG repo —
// while the working project was this one. That is a CORRECTNESS defect, not a
// budget one: a rule from the wrong project is not a smaller persona, it is a
// wrong one, and the agent cannot tell the difference from inside the block.
//
// Scope is read out of what authors ALREADY write; there is no new file format,
// no frontmatter and no new section:
//   - a parenthetical project tag on the label — `**X** (orchard-ops): …`, which
//     several bullets already carry, and
//   - a repo-relative artifact path in the body — `tools/kg.py`.
//
// This stays PURE (see the module header): whether a path exists in the current
// project is injected by the caller as `scope.hasPath`, so nothing here touches
// disk and the visualiser can replay the same decision offline.
//
// The matcher is deliberately ASYMMETRIC. Dropping a genuine standing rule is
// far worse than occasionally injecting a foreign one, so every "cannot tell"
// resolves to KEEP: no hints, no scope context, no resolvable project root, a
// tag that does not parse as a name — all universal. Only a POSITIVE mismatch
// (a named project that is not this one, or an artifact path with no trace of it
// here) drops a bullet.
//
// TIER 0 IS NOT SCOPED. Measured across 6 projects, filtering there freed 0
// chars and admitted 0 extra bullets — 12 of the 13 project-scoped bullets are
// reference/conditional duty, and the single `always` one is not selected today
// anyway. So tier 0 would pay the risk of a wrong drop for no gain.

// The scope tag lives on the LABEL — `**X** (orchard-ops): body` — so only the label
// is searched, and only its tail. A parenthetical anywhere else is prose:
// "Never pipe a gate through head/tail/grep (swallows exit codes)" names no
// project, and reading one out of it would drop a real rule everywhere.
const SCOPE_HEAD_MAX_CHARS = 120;
// Even in the label position, a parenthetical of running prose ("(granted
// 2026-07-27: …)") is an aside. Real tags are 1-3 words.
const SCOPE_TAG_MAX_WORDS = 4;
const SCOPE_TAG_RE = /\(([^)\n]{1,60})\)\s*\*{0,2}\s*$/;
// A name-shaped token: opens alphanumeric, ≥3 chars, only identifier punctuation.
const SCOPE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{2,}$/u;
const SCOPE_DATE_RE = /^\d{4}(?:-\d{1,2}){0,2}$/;
// Words that appear INSIDE a tag without naming anything: containers
// ("(orchard-lessons repo)") and modes ("(invokable)", "(optional)"). A mode read
// as a project name would scope a rule to a project that does not exist, which
// drops it everywhere — the one outcome this design must not produce.
const SCOPE_GENERIC_TOKENS = new Set([
  "repo", "repos", "repository", "project", "projects", "plugin", "package",
  "app", "and", "the", "for", "only", "wip", "todo", "draft", "new", "old",
  "invokable", "optional", "experimental", "deprecated", "internal", "manual",
  "auto", "global", "default", "amended", "granted", "added", "updated",
]);
// A path segment that is itself a filename ("AGENTS.md") cannot be a directory.
const FILENAME_SEGMENT_RE = /\.[a-z]{1,6}$/i;
// A repo-relative artifact path: ≥2 segments, a file extension, and NOT rooted
// at `/` or `~` (an absolute path names the machine, not the repo — those are
// reference-class facts and never reach tier 1 anyway).
const REPO_REL_PATH_RE =
  /(?:^|[\s(`"'*])((?![/~])[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,6})(?=$|[\s)`"'*,.;:!?])/gi;

// The bullet's label, or "" when it has none (no `: ` separator) or when it is
// too long to be a label.
function scopeHead(text) {
  const s = String(text || "").normalize("NFKC").trim();
  const i = s.search(/:\s/);
  if (i < 0) return "";
  const head = s.slice(0, i);
  return head.length <= SCOPE_HEAD_MAX_CHARS ? head : "";
}

/** Project names tagged on the bullet's label, lowercased. */
function projectNamesIn(text) {
  const head = scopeHead(text);
  if (!head) return [];
  const m = SCOPE_TAG_RE.exec(head);
  if (!m) return [];
  const tag = m[1].trim();
  if (!tag || tag.split(/\s+/).length > SCOPE_TAG_MAX_WORDS) return [];
  const names = [];
  // `/` and `,` separate co-tagged projects: "(2026-07, orchard-api/orchard-flow)".
  for (const raw of tag.split(/[\s,;/|+]+/)) {
    const t = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t || SCOPE_DATE_RE.test(t)) continue;
    if (SCOPE_GENERIC_TOKENS.has(t) || !SCOPE_NAME_RE.test(t)) continue;
    if (!names.includes(t)) names.push(t);
  }
  return names;
}

/** Repo-relative artifact paths named anywhere in the bullet. */
function repoPathsIn(text) {
  const out = [];
  for (const m of String(text || "").normalize("NFKC").matchAll(REPO_REL_PATH_RE)) {
    const rel = m[1];
    const segs = rel.split("/");
    // No traversal: these strings are fed to a caller-supplied fs probe.
    if (segs.some((seg) => seg === "." || seg === "..")) continue;
    // `AGENTS.md/CLAUDE.md` is an ALTERNATION, not a path — and the bullet it
    // appears in is a universal rule about every repo, so reading it as an
    // artifact would have dropped a standing rule everywhere. A directory
    // segment that looks like a filename means this is not a path.
    if (segs.slice(0, -1).some((seg) => FILENAME_SEGMENT_RE.test(seg))) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** `{names, paths}` — the scope evidence a bullet carries in its own text. */
function projectScopeHints(text) {
  return { names: projectNamesIn(text), paths: repoPathsIn(text) };
}

// The project slug is a path with separators flattened to "-", so a project name
// is present iff it sits on a token boundary inside it.
function slugMatchesName(slug, name) {
  const s = String(slug || "").toLowerCase();
  if (!s || !name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[-_/\\\\.])${esc}(?:$|[-_/\\\\.])`).test(s);
}

/**
 * Does `hints` admit the current project? See the asymmetry note above: this
 * returns true whenever scope cannot be determined.
 *
 * `scope` is `{slug, hasPath}` — `slug` is the project store slug (a flattened
 * absolute path), `hasPath(rel)` answers whether a repo-relative path exists in
 * the current project, or is absent when the project root could not be resolved.
 */
function admitsProject(hints, scope) {
  if (!hints || !scope) return true;
  const slug = scope.slug || "";
  const hasPath = typeof scope.hasPath === "function" ? scope.hasPath : null;
  if (!slug && !hasPath) return true;

  const names = hints.names || [];
  const paths = hints.paths || [];
  if (!names.length && !paths.length) return true;

  if (names.length) {
    // An explicit tag is the author's own statement of scope, so it decides —
    // including against a path that happens to resolve here.
    if (!slug) return true; // cannot tell
    return names.some((n) => slugMatchesName(slug, n));
  }

  if (!hasPath) return true; // project root unresolvable → cannot tell
  for (const p of paths) {
    if (hasPath(p)) return true;
    // The directory alone is enough: a repo that HAS `tools/` but not
    // `tools/kg.py` may simply not have written the file yet, and keeping the
    // rule there is the cheap error.
    const top = p.split("/")[0];
    if (top && hasPath(top)) return true;
  }
  return false;
}

/**
 * Per-turn projection: an always-on insurance line (the 1-2 strongest `always`
 * items, cover for a compaction that dropped tier 0) plus the `conditional`
 * items that the current prompt actually triggers.
 *
 * `options.projectScope` ({slug, hasPath}) additionally drops conditional items
 * that name a DIFFERENT project — see the project-scope note above. Omitting it
 * reproduces the unscoped behaviour exactly, so callers with no project context
 * (the CLI outside a repo) need do nothing.
 */
function projectTier1(sections, options = {}) {
  const budgetChars = Math.max(0, options.maxChars ?? DEFAULT_TIER1_MAX_CHARS);
  const insuranceBudget = Math.min(
    budgetChars,
    Math.max(0, options.insuranceChars ?? DEFAULT_INSURANCE_MAX_CHARS)
  );
  const bulletMax = Math.max(MIN_BULLET_CHARS, options.bulletMaxChars ?? DEFAULT_BULLET_MAX_CHARS);
  const minScore = options.minScore ?? 0.12;
  const annotated = annotate(sections);
  if (!annotated.length || budgetChars === 0) return emptyProjection(budgetChars);

  const flat = [];
  annotated.forEach((s, si) => {
    for (const b of s.bullets) flat.push({ ...b, sectionName: s.name, sectionIndex: si });
  });

  const chosen = [];
  const lines = [];
  let used = 0;

  const take = (bullet, cap, reason, score) => {
    const available = Math.min(cap, budgetChars - used - 3);
    if (available < MIN_BULLET_CHARS) return false;
    const { text, truncated } = truncateAtWord(bullet.text, available);
    if (!text) return false;
    used += lineCost(text);
    lines.push(text);
    chosen.push({
      sectionName: bullet.sectionName,
      index: bullet.index,
      duty: bullet.duty,
      reason,
      score: Number(score.toFixed(4)),
      sourceChars: bullet.chars,
      injectedChars: text.length,
      truncated,
    });
    return true;
  };

  // Insurance: strongest signal first, shortest first on ties — cover should be
  // cheap, it is paid on every single turn.
  const insurance = flat
    .filter((b) => b.duty === "always" && insuranceScore(b.text) > 0)
    .map((b) => ({ b, s: insuranceScore(b.text) }))
    .sort((x, y) => y.s - x.s || x.b.chars - y.b.chars ||
      x.b.sectionIndex - y.b.sectionIndex || x.b.index - y.b.index);

  let insuranceUsed = 0;
  for (const { b, s } of insurance.slice(0, 2)) {
    const cap = Math.min(bulletMax, insuranceBudget - insuranceUsed - 3);
    if (cap < MIN_BULLET_CHARS) break;
    const before = used;
    if (take(b, cap, "insurance", s)) insuranceUsed += used - before;
  }

  // Relevance: conditional items the prompt actually reaches for.
  const qTokens = new Set(significantTokens(options.query || ""));
  // With no query tokens relevanceScore returns 0 for every bullet before it
  // ever consults the table, so building the corpus would be provably dead work
  // (~7 ms of a ~17,5 ms per-turn path). The guard is ONLY for the empty query:
  // on real prompts the relevance half earns its keep (≥1 bullet on 7 of 10
  // sampled queries), so do not widen this into "skip idf when it looks cheap".
  const { idf, tokens: bulletTokens } = qTokens.size
    ? buildIdf(flat)
    : { idf: null, tokens: null };
  // Composite key: NUL separates the two parts. A section name can never
  // contain NUL, so `${name}\x00${index}` is unambiguous — no name/index pair
  // can collide with another. Written as the \x00 escape, never a raw byte:
  // a raw NUL makes the file "binary" to file(1) and grep, which then reports
  // "no matches" for patterns that are in fact present.
  const seen = new Set(chosen.map((c) => `${c.sectionName}\x00${c.index}`));
  // Scope is checked BEFORE SELECTION — the loop below — and that is the part
  // that matters: a foreign rule that outranks a universal one must not take the
  // budget and then be discarded, leaving the universal one unreconsidered.
  //
  // WHERE in the pre-selection pipeline it runs is free, and it runs last: it is
  // one more stable filter over the same array, so the survivors and their order
  // are identical either way, but `projectScopeHints` (NFKC normalise + a global
  // matchAll) is by far the most expensive predicate here and the cheap
  // `minScore` cut already discards most conditional bullets. Running it first
  // paid full price for ~10% of the persona pass on bullets nothing could select.
  const scope = options.projectScope || null;
  const inScope = scope ? (b) => admitsProject(projectScopeHints(b.text), scope) : () => true;
  const ranked = flat
    .filter((b) => b.duty === "conditional" && !seen.has(`${b.sectionName}\x00${b.index}`))
    .map((b) => ({ b, s: relevanceScore(b.text, qTokens, idf, bulletTokens && bulletTokens.get(b)) }))
    .filter((x) => x.s >= minScore && inScope(x.b))
    .sort((x, y) => y.s - x.s || x.b.sectionIndex - y.b.sectionIndex || x.b.index - y.b.index);

  for (const { b, s } of ranked) {
    if (budgetChars - used - 3 < MIN_BULLET_CHARS) break;
    take(b, bulletMax, "relevance", s);
  }

  const text = lines.map((l) => `- ${l}`).join("\n");
  return { text, bullets: chosen, usedChars: text.length, budgetChars };
}

// ── Backwards compatibility ──

/**
 * Exactly today's projection (memory_recall.getPersona + truncate): first 5
 * non-heading lines joined with "; ", cut at 400 chars. Kept as ONE explicit,
 * testable definition so the fallback path is not re-invented at each call site
 * when the tiered projection comes back empty.
 */
function legacyProjection(text, options = {}) {
  const maxChars = options.maxChars ?? LEGACY_MAX_CHARS;
  const maxLines = options.maxLines ?? LEGACY_MAX_LINES;
  const persona = String(text == null ? "" : text);
  if (!persona.trim()) return "";

  const summary = [];
  for (const line of persona.trim().split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) summary.push(trimmed.slice(2));
    else if (trimmed) summary.push(trimmed);
    if (summary.length >= maxLines) break;
  }
  const joined = summary.join("; ");
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

/**
 * Convenience for callers: tiered projection with the legacy string as fallback
 * when the persona has no parseable structure or nothing classifies as always.
 */
function projectPersona(text, options = {}) {
  const sections = parsePersona(text);
  const tier0 = projectTier0(sections, options.tier0 || {});
  const tier1 = projectTier1(sections, options.tier1 || {});
  const fallback = tier0.text ? "" : legacyProjection(text, options.legacy || {});
  return { sections, tier0, tier1, fallback, usedCore: prefersCore(sections) };
}

/**
 * WS2 write-side budget gate (pure). A persona is only useful if every standing
 * (`always`) rule actually reaches the agent; the measured failure is SILENT —
 * the reader can only drop, never condense, so overflow lands on standing rules
 * and never surfaces. This runs the REAL tier-0 projection and reports the two
 * write-side defects that cause the drop, so the CLI can reject at write time
 * (gate-not-convention) instead of the consolidator learning the rule by habit.
 *
 * Deviation from the redesign plan's borrowed "2000 chars" cap: that was
 * upstream's number for a whole-persona.md injection model. THIS plugin injects
 * a tier-0 projection whose real budget is DEFAULT_TIER0_MAX_CHARS (4800), so the
 * honest gate is "does the always-set survive tier-0 packing", not a foreign
 * literal. Callers may override via opts for the code/team family (WS2b).
 *
 * Returns { ok, violations, alwaysCount, deliveredCount }. Never throws.
 */
function checkPersonaBudget(text, opts = {}) {
  const maxChars = Math.max(0, opts.maxChars ?? DEFAULT_TIER0_MAX_CHARS);
  // The per-bullet WRITE rule is the skill's documented 160 (one rule per bullet),
  // deliberately tighter than DEFAULT_BULLET_MAX_CHARS (600), which is the tier-0
  // ELIGIBILITY threshold above which a bullet is dropped whole. We flag at 160
  // (discipline) and separately detect real overflow using true delivery params.
  const bulletMax = Math.max(MIN_BULLET_CHARS, opts.bulletMaxChars ?? 160);
  const sections = annotate(parsePersona(text));

  const always = [];
  for (const s of sections) {
    for (const b of s.bullets) {
      if (b.duty === "always") always.push({ ...b, section: s.name });
    }
  }

  const violations = [];

  // (1) Per-bullet ceiling — one rule per bullet, whole or not at all.
  for (const b of always) {
    if (b.chars > bulletMax) {
      violations.push({
        kind: "bullet_over_max",
        section: b.section,
        lineNo: b.lineNo,
        chars: b.chars,
        max: bulletMax,
        preview: b.text.slice(0, 80),
      });
    }
  }

  // (2) Tier-0 overflow — run the real projection with TRUE delivery params
  // (default eligibility cap, not the tighter write rule); any always bullet it
  // can't deliver is a rule the agent silently never sees.
  const proj = projectTier0(sections, { maxChars });
  const delivered = proj.bullets.length;
  if (delivered < always.length) {
    violations.push({
      kind: "tier0_overflow",
      alwaysCount: always.length,
      deliveredCount: delivered,
      droppedCount: always.length - delivered,
      budgetChars: maxChars,
    });
  }

  return { ok: violations.length === 0, violations, alwaysCount: always.length, deliveredCount: delivered };
}

module.exports = {
  parsePersona,
  checkPersonaBudget,
  classifyDuty,
  annotate,
  dutyCounts,
  prefersCore,
  coreSection,
  projectTier0,
  projectTier1,
  projectPersona,
  legacyProjection,
  truncateAtWord,
  // Exported as a PAIR: buildIdf's `{idf, tokens}` is relevanceScore's input, and
  // scene_nav.js reuses both to rank scenes rather than growing a second scorer
  // that would drift from this one. Both are pure and corpus-agnostic — they only
  // require the items to carry a `.text`.
  buildIdf,
  relevanceScore,
  // Project scoping: extractor and matcher are exported separately so the
  // caller that owns the filesystem (memory_recall) can build the scope context
  // and the visualiser can explain a drop without re-deriving either half.
  projectScopeHints,
  admitsProject,
  CHARS_PER_TOKEN,
  DEFAULT_TIER0_MAX_TOKENS,
  DEFAULT_TIER0_MAX_CHARS,
  DEFAULT_TIER1_MAX_CHARS,
  DEFAULT_INSURANCE_MAX_CHARS,
  DEFAULT_BULLET_MAX_CHARS,
  MIN_BULLET_CHARS,
  LEGACY_MAX_CHARS,
  LEGACY_MAX_LINES,
};
