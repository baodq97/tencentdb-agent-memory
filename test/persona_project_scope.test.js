// test/persona_project_scope.test.js
//
// persona.md is ONE GLOBAL document while L1/L2 are per project, so a
// `conditional` bullet written for another repo used to arrive here as a
// standing rule. Measured leak: the prompt "run the eval suite and report
// numbers" selected a rule about `tools/kg.py` — a file that exists only in a KG
// repo — while the working project was this one.
//
// The scoping rule is deliberately asymmetric (keep when in doubt), so most of
// what is asserted here is what must still be KEPT. Dropping a genuine standing
// rule is the expensive failure; injecting a foreign one occasionally is not.
//
// Filesystem: the projection half is pure (inline fixtures, no disk). The
// `projectScopeFor` half necessarily probes the filesystem — it uses a temp dir
// created here and NEVER ~/.memory-tencentdb (see eval_isolation.test.js for why
// that rule exists: an earlier test destroyed the user's real memories).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parsePersona,
  annotate,
  projectTier0,
  projectTier1,
  projectScopeHints,
  admitsProject,
} = require("../scripts/persona_projection.js");
const { projectScopeFor } = require("../scripts/memory_recall.js");

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// Shapes taken from the real persona: a path-scoped rule, a tag-scoped rule, an
// unscoped rule, and a rule whose parenthetical is prose rather than a tag.

const PERSONA = `# User Persona

## Preferences
- Prefers Vietnamese in chat and English in every committed artifact.

## Standing Instructions
- KG foundation: never hand-read the YAML — go through tools/kg.py, report provenance and confidence per fact.
- **Curriculum exams** (orchard-lessons): grade the exam when the lesson ships.
- Staging/gateway DB migrations: stop the gateway first, then run the migration job.
- **Standing bypass authorization** (granted 2026-07-27: "cấp quyền"): spawn PM sessions with permissions pre-granted when dispatching.
`;

const SECTIONS = parsePersona(PERSONA);
const KG = "KG foundation";
const EXAMS = "Curriculum exams";
const MIGRATIONS = "Staging/gateway DB migrations";

/** Bullet text of every conditional item the fixture is built around. */
function bulletStartingWith(prefix) {
  for (const s of annotate(SECTIONS)) {
    for (const b of s.bullets) if (b.text.replace(/\*/g, "").startsWith(prefix)) return b;
  }
  throw new Error(`fixture bullet not found: ${prefix}`);
}

// The fixture is only meaningful if these are tier-1 items to begin with.
test("fixture: the scoped bullets classify as conditional (tier 1)", () => {
  for (const p of [KG, EXAMS, MIGRATIONS]) {
    assert.strictEqual(bulletStartingWith(p).duty, "conditional", p);
  }
});

// ── Hint extraction ─────────────────────────────────────────────────────────

test("projectScopeHints reads a repo-relative artifact path out of the body", () => {
  assert.deepStrictEqual(projectScopeHints(bulletStartingWith(KG).text), {
    names: [],
    paths: ["tools/kg.py"],
  });
});

test("projectScopeHints reads a project tag off the label", () => {
  assert.deepStrictEqual(projectScopeHints(bulletStartingWith(EXAMS).text), {
    names: ["orchard-lessons"],
    paths: [],
  });
});

test("projectScopeHints splits co-tagged projects and ignores dates and filler", () => {
  const h = projectScopeHints("**Evals skills like code** (2026-07, orchard-api/orchard-flow): pre-register the bar.");
  assert.deepStrictEqual(h.names, ["orchard-api", "orchard-flow"]);
  assert.deepStrictEqual(projectScopeHints("**Dogfood sizing** (orchard-lessons repo): size the role ceiling.").names,
    ["orchard-lessons"]);
});

test("projectScopeHints ignores a parenthetical that is prose, not a tag", () => {
  // Reading "granted"/"cấp quyền" as a project name would drop a real standing
  // rule in every project — the exact failure this design must not have.
  assert.deepStrictEqual(projectScopeHints(bulletStartingWith("Standing bypass authorization").text), {
    names: [],
    paths: [],
  });
});

test("projectScopeHints does not mistake shell pipelines, shapes or absolute paths for artifacts", () => {
  assert.deepStrictEqual(projectScopeHints(bulletStartingWith(MIGRATIONS).text), { names: [], paths: [] });
  for (const text of [
    // A parenthetical in the BODY is prose, never a tag.
    "Never pipe a gate through head/tail/grep (swallows exit codes).",
    "Ops docs: scrub sensitive values (tokens, secrets) before committing.",
    "Answer in the shape he names (STATE/DESIGN/DECISION).",
    "Workstation at /home/dev/projects/thing/main.py, CUDA 12.6.",
    "Config lives in ~/.config/app/settings.json on every box.",
    // An ALTERNATION, not a path — and the real bullet carrying it ("No AI
    // attribution trailers…", "Read each folder's AGENTS.md/CLAUDE.md") is a
    // universal rule, so misreading it drops a standing rule in every project.
    "Read each folder AGENTS.md/CLAUDE.md before editing anything under it.",
    "**Mode tag is not a project** (invokable): delegate when told to.",
  ]) {
    assert.deepStrictEqual(projectScopeHints(text), { names: [], paths: [] }, text);
  }
});

// ── Matching ────────────────────────────────────────────────────────────────

const NO_PATHS = { slug: "-home-dev-projects-tencentdb-agent-memory", hasPath: () => false };

test("admitsProject keeps everything it cannot decide", () => {
  const hints = projectScopeHints(bulletStartingWith(KG).text);
  assert.strictEqual(admitsProject({ names: [], paths: [] }, NO_PATHS), true, "no hints");
  assert.strictEqual(admitsProject(hints, null), true, "no scope context at all");
  assert.strictEqual(admitsProject(hints, {}), true, "empty scope context");
  assert.strictEqual(admitsProject(hints, { slug: "-x-y" }), true, "unresolvable project root");
  assert.strictEqual(admitsProject({ names: ["orchard-ops"], paths: [] }, { hasPath: () => false }), true, "no slug");
});

test("admitsProject drops a bullet tagged with a different project, keeps its own", () => {
  const hints = projectScopeHints(bulletStartingWith(EXAMS).text);
  assert.strictEqual(admitsProject(hints, NO_PATHS), false);
  assert.strictEqual(admitsProject(hints, { slug: "-home-dev-projects-orchard-lessons" }), true);
  // Token boundary, not substring: "orchard-lessons" must not match "myorchard-lessonsX".
  assert.strictEqual(admitsProject(hints, { slug: "-home-dev-projects-myorchard-lessonsx" }), false);
});

test("admitsProject drops an artifact path with no trace here, keeps it where it lives", () => {
  const hints = projectScopeHints(bulletStartingWith(KG).text);
  assert.strictEqual(admitsProject(hints, NO_PATHS), false);
  assert.strictEqual(admitsProject(hints, { slug: "-p", hasPath: (r) => r === "tools/kg.py" }), true);
  // The directory alone is enough: the file may simply not be written yet.
  assert.strictEqual(admitsProject(hints, { slug: "-p", hasPath: (r) => r === "tools" }), true);
});

// ── Tier 1 selection ────────────────────────────────────────────────────────

const QUERY = "run the kg yaml provenance check";

function tier1Texts(scope) {
  return projectTier1(SECTIONS, { query: QUERY, maxChars: 4000, projectScope: scope })
    .bullets.map((b) => b.index + "@" + b.sectionName);
}

function selected(scope) {
  return projectTier1(SECTIONS, { query: QUERY, maxChars: 4000, projectScope: scope }).text;
}

test("tier 1 without project context is unchanged — the foreign rule is still selected", () => {
  // Baseline: this is today's behaviour and the CLI-outside-a-repo path.
  assert.match(selected(null), /KG foundation/);
  assert.deepStrictEqual(tier1Texts(null), tier1Texts(undefined));
});

test("tier 1 drops a rule scoped to another project", () => {
  const elsewhere = { slug: "-home-dev-projects-tencentdb-agent-memory", hasPath: () => false };
  assert.doesNotMatch(selected(elsewhere), /KG foundation/);
});

test("tier 1 keeps the SAME rule when working in its own project", () => {
  const home = { slug: "-home-dev-projects-orchard-kg", hasPath: (r) => r === "tools" || r === "tools/kg.py" };
  assert.match(selected(home), /KG foundation/);
});

test("tier 1 keeps unscoped and ambiguously-scoped rules under every scope", () => {
  const q = "migration gateway bypass permission dispatch";
  const opts = { query: q, maxChars: 4000 };
  const elsewhere = { slug: "-home-dev-projects-nothing-here", hasPath: () => false };
  const withScope = projectTier1(SECTIONS, { ...opts, projectScope: elsewhere }).text;
  const without = projectTier1(SECTIONS, opts).text;
  assert.match(without, /Staging\/gateway/);
  assert.strictEqual(withScope, without, "no universal bullet may be lost");
});

// ── Tier 0 is not scoped ────────────────────────────────────────────────────

test("tier 0 output is byte-identical with and without a project scope", () => {
  // Measured: scoping tier 0 frees 0 chars and admits 0 extra bullets across 6
  // projects, so it would be pure risk. The option must be inert there.
  const scope = { slug: "-home-dev-projects-nothing-here", hasPath: () => false };
  const base = projectTier0(SECTIONS, {});
  const scoped = projectTier0(SECTIONS, { projectScope: scope });
  assert.strictEqual(scoped.text, base.text);
  assert.deepStrictEqual(scoped.bullets, base.bullets);
});

// ── Scope context from a project slug ───────────────────────────────────────

test("projectScopeFor resolves the project root and probes inside it", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-scope-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "orchard-kg");
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools", "kg.py"), "# fixture\n");

  const slug = root.replace(/:/g, "-").replace(/[\\/]/g, "-");
  const scope = projectScopeFor(slug);
  assert.strictEqual(scope.slug, slug);
  assert.strictEqual(typeof scope.hasPath, "function");
  assert.strictEqual(scope.hasPath("tools/kg.py"), true);
  assert.strictEqual(scope.hasPath("tools"), true);
  assert.strictEqual(scope.hasPath("docs/api.md"), false);
  // Containment guard: persona text never gets to probe outside the repo.
  assert.strictEqual(scope.hasPath("../../etc/passwd"), false);

  // And the bullet that leaked is admitted here, where it belongs.
  assert.strictEqual(admitsProject(projectScopeHints(bulletStartingWith(KG).text), scope), true);
});

test("projectScopeFor degrades to keep-everything with no project or no root", () => {
  assert.strictEqual(projectScopeFor(""), null);
  const gone = projectScopeFor("-no-such-directory-anywhere-42");
  // Unresolvable root → no path evidence either way → "cannot tell" → KEEP.
  // The probe is deferred, so this is answered by hasPath itself rather than by
  // omitting hasPath; the admitsProject verdict below is the invariant, and it
  // is the same one the eager version produced.
  assert.strictEqual(gone.hasPath("tools/kg.py"), true, "cannot tell → keep");
  assert.strictEqual(gone.hasPath("literally/anything"), true);
  assert.strictEqual(admitsProject(projectScopeHints(bulletStartingWith(KG).text), gone), true);
});

test("projectScopeFor does not touch the filesystem until a path is actually probed", (t) => {
  // The root is consumed ONLY by hasPath, and only bullets carrying a
  // repo-relative path hint ever reach it — 8 of 85 in the real persona, since a
  // name-tagged bullet is decided by the slug alone. Resolving eagerly spent
  // ~16 statSync calls per turn to answer a question most turns never ask.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-scope-lazy-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "orchard-kg");
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  const slug = root.replace(/:/g, "-").replace(/[\\/]/g, "-");

  // pathFromSlugProbe walks with fs.statSync; memory_reader holds the same
  // node:fs module object this file does, so counting on the property works.
  const realStat = fs.statSync;
  let stats = 0;
  fs.statSync = (...a) => { stats++; return realStat.apply(fs, a); };
  t.after(() => { fs.statSync = realStat; });

  const scope = projectScopeFor(slug);
  assert.strictEqual(scope.slug, slug);
  assert.strictEqual(stats, 0, "constructing the scope must not probe the filesystem");

  assert.strictEqual(scope.hasPath("tools"), true, "and the deferred probe still resolves the root");
  assert.ok(stats > 0, "the probe happens on first use");

  const afterFirst = stats;
  scope.hasPath("tools");
  assert.strictEqual(stats, afterFirst, "repeat probe of the same path is memoised");
  scope.hasPath("docs");
  assert.strictEqual(stats, afterFirst, "and the ROOT resolution is not redone for a new path");
});
