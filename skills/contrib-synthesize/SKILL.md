---
name: contrib-synthesize
description: Use this skill when someone wants to LEARN from engineers they've already profiled — extracting actionable lessons from contributor personas. Trigger on intents like: "what do the top SWEs / engineers / contributors I've profiled have in common", "extract their shared / common capabilities", "turn a contributor's profile into copyable habits, heuristics, or a learnable playbook", "what habits should I copy from <person>", or "compare me / my style to <role-model> dimension-by-dimension and find my gap". Also covers surfacing exemplar teaching quotes across profiled engineers. Operates on existing personas (built via contrib-consolidate); cross-engineer comparison or common-capability synthesis needs ≥2 subjects. Do NOT use for: building, ingesting, or inspecting a single persona's raw contents; commit/trajectory stats; summarizing documents; recalling what you know about the user; or playbooks unrelated to engineer profiles (e.g. team incident-response runbooks).
---

# Contributor Synthesize

Turn multiple contributor personas into (a) the L4 capability model, (b) a
learnable playbook per subject, and (c) exemplar quotes. The deterministic
prevalence math is done by the CLI; you write the interpretation for learners.

**Read `references/synthesis-guide.md` first** — the altitude test for playbook
heuristics, how to mine exemplar quotes, the you-vs-role-model gap table, and the
"preliminary until ≥3 subjects" caveat for L4.

## Workflow

### 1. Compute the deterministic L4 backbone

```bash
tmem contrib capabilities
```

Prints each common capability with prevalence % and exemplar. If it says
"need >=2 subjects", tell the user to ingest + build at least one more subject
and stop.

### 2. Capability model (narrative)

Pull every persona in one call to reason across them:

```bash
tmem contrib personas         # all subject personas as JSON
```

For each common capability (from step 1), write 1–2 sentences: what the shared
behaviour is, the prevalence ("N/M subjects"), and who exemplifies it best (the
exemplar subject), citing one piece of their evidence.

### 3. Learnable playbook (per subject)

Read the subject persona:

```bash
tmem contrib persona <id>
```

Distil it into ≥8 emulable heuristics — concrete enough to copy. Examples of the
right altitude:
- "Split features into ≤150-LOC stacked PRs, one concern each."
- "Every bug-fix PR ships its regression test in the same diff."
- "Review comments always state the why and label severity (Nit/Optional)."

Each heuristic must trace to evidence in the persona/atoms.

### 4. Exemplar quotes

From the subject's review comments (in their atoms' evidence), surface 3–5 of the
best teaching comments verbatim, each with the principle it illustrates. These
are lessons, not metrics.

### 5. (Wow) You vs role model

The user already has a self-persona — the plugin built it from their own Claude
Code history. Don't make them ingest their own GitHub. Pull both sides directly:

```bash
tmem persona                  # the user's existing self-persona (conversation-derived)
tmem contrib persona <id>     # the role model's 11-dimension persona
```

These use different schemas (the self-persona is `user/feedback/project` style,
not the 11 GitHub dimensions), so this is a **qualitative gap analysis**, not a
1:1 table. For each role-model dimension, state what their habit is, what the
user's persona suggests about that area (or "not evidenced" if the self-persona
is silent), and one concrete thing to adopt. Lead with the gaps worth closing.

If the user instead wants to compare two *profiled contributors* (peer/team), use
the deterministic table command: `tmem contrib compare <id-a> <id-b>`.

### 6. (Wow) Trajectory narration

```bash
tmem contrib trajectory <id>
```

This prints per-year cadence + style (commits, PRs, reviews given, avg commit
subject length, conventional-prefix %). Narrate the *arc*: when output scaled,
when commit style matured, when they shifted from authoring toward review. Be
honest that this measures cadence/style, not PR size (LOC is not available).

### 7. Guardrails

- Lead with interpretation for learning, not measurement.
- Tone/sentiment never ranks a person. No vanity counts.
- The L4 model is "preliminary" until ≥3 subjects — say so.
