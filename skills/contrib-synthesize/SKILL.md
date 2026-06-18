---
name: contrib-synthesize
description: Synthesise the L4 capability model of top SWEs and produce learnable playbooks and exemplar quotes from contributor personas. Triggers when the user says "contributor capabilities", "what do top SWEs have in common", "build the playbook", "compare me to <user>". Needs >=2 personas.
---

# Contributor Synthesize

Turn multiple contributor personas into (a) the L4 capability model, (b) a
learnable playbook per subject, and (c) exemplar quotes. The deterministic
prevalence math is done by the CLI; you write the interpretation for learners.

## Workflow

### 1. Compute the deterministic L4 backbone

```bash
tmem contrib capabilities
```

Prints each common capability with prevalence % and exemplar. If it says
"need >=2 subjects", tell the user to ingest + build at least one more subject
and stop.

### 2. Capability model (narrative)

For each common capability, write 1–2 sentences: what the shared behaviour is,
the prevalence ("N/M subjects"), and who exemplifies it best (the exemplar
subject), citing one piece of their evidence.

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

If the user asks to compare themselves, ensure both the user and the role model
are ingested subjects, then produce a per-dimension diff table: for each of the
11 dimensions, one line on the role model, one on the user, and the gap to close.

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
