#!/usr/bin/env node
/**
 * Sensitive-data classifier (WS7).
 *
 * The global/shared persona store must NOT accumulate machine/infra secrets:
 * OAuth redirect URIs, private/internal hostnames, cloud subscription/tenant ids,
 * API keys, tokens, or `*_SECRET=`/`*_TOKEN=`/`*_KEY=` env assignments. This module
 * is a pure, dependency-free classifier that the writer wires in to block such
 * content from propagating cross-project. (It intentionally does NOT try to flag
 * arbitrary "prod URLs" — a generic https matcher is all false positives.)
 *
 * Local-first: pure regex, no LLM, no network. Precise patterns, low false
 * positives — benign prose (personal preferences, plans) must pass through.
 *
 * Exports:
 *   isSensitive(text)      -> boolean
 *   redactSensitive(text)  -> string  (secret spans -> ‹redacted:kind›)
 *   SENSITIVE_PATTERNS     -> [{ kind, pattern }]  (inspectable ruleset)
 */
"use strict";

const PLACEHOLDER = (kind) => `‹redacted:${kind}›`;

/**
 * Ordered ruleset. Each rule has a stable `kind` (used in the placeholder) and
 * a global RegExp. Order matters for redaction: more specific / longer spans
 * are listed before broader ones so they mask first.
 *
 * All patterns are `g` (global) so redactSensitive can replace every match.
 */
const SENSITIVE_PATTERNS = [
  {
    // JWT: three base64url segments separated by dots, header starts "eyJ".
    kind: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  },
  {
    // OAuth redirect URI: a URL carrying a redirect_uri query parameter.
    kind: "redirect_uri",
    pattern: /https?:\/\/[^\s"'<>]*[?&]redirect_uri=[^\s"'<>]+/gi,
  },
  {
    // Explicit *_REDIRECT_URI env assignment.
    kind: "redirect_uri",
    pattern: /[A-Z0-9_]*REDIRECT_URI\s*[=:]\s*[^\s"'<>]+/gi,
  },
  {
    // env-var value assignment: NAME_SECRET/TOKEN/KEY/PASSWORD/... = value.
    kind: "env_secret",
    pattern:
      /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)\b\s*[=:]\s*["']?[^\s"'<>]+["']?/gi,
  },
  {
    // AWS access key id.
    kind: "aws_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    // GitHub tokens (classic + fine-grained + oauth/app).
    kind: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    // Stripe secret / restricted keys.
    kind: "stripe_key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  },
  {
    // Google API key.
    kind: "gcp_key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    // Slack token.
    kind: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    // Cloud subscription/tenant id: a UUID within ~40 chars of a STRONG cloud
    // context keyword. Only unambiguous cloud terms qualify — bare "client id" /
    // "directory" are common in benign prose and were dropped to avoid flagging a
    // UUID next to them (a bare UUID alone is never treated as sensitive).
    kind: "cloud_id",
    pattern:
      /\b(?:azure|subscription|tenant|workos|aad)\b[\s\S]{0,40}?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    // Private / internal hostname (optionally with a port).
    kind: "private_host",
    pattern:
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|local|intranet|lan)\b(?::\d{2,5})?/gi,
  },
];

function isSensitive(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const { pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

function redactSensitive(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text;
  for (const { kind, pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, PLACEHOLDER(kind));
  }
  return out;
}

module.exports = { isSensitive, redactSensitive, SENSITIVE_PATTERNS };
