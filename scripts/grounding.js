#!/usr/bin/env node
/**
 * Post-extraction grounding check (port of upstream PR #266, Unicode-aware).
 *
 * The agent extracts L1 atoms from a transcript and CAN confabulate facts that
 * never appeared in the source. This module rejects memories whose content does
 * not overlap the source text enough to be considered grounded.
 *
 * Local-first: pure string math, no LLM, no network. Unicode-aware so Vietnamese
 * (and other non-ASCII) content is not falsely dropped.
 *
 * GRACEFUL: when no source text is available (e.g. atom has no resolvable
 * source_message_ids), we cannot disprove grounding, so we ACCEPT.
 */
"use strict";

const DEFAULT_THRESHOLD = 0.3;

// Common, content-free tokens that would inflate overlap ratios. EN + VI.
const STOPWORDS = new Set([
  // English (incl. short function words that would inflate overlap)
  "about", "after", "also", "and", "assistant", "because", "from", "have",
  "into", "that", "this", "user", "with", "your", "what", "when", "they",
  "them", "is", "in", "of", "to", "on", "at", "it", "an", "or", "as", "be",
  "by", "do", "if", "my", "no", "so", "up", "we", "the", "are", "for", "was",
  // Vietnamese
  "và", "các", "của", "là", "một", "có", "cho", "tôi", "được", "những",
  "này", "đó", "thì", "rằng", "khi", "với", "người", "dùng", "đã", "sẽ",
  "mà", "về", "ở", "cũng", "rồi", "nhé",
]);

function normalize(text) {
  return String(text == null ? "" : text).normalize("NFKC").toLowerCase();
}

/**
 * Significant tokens: Unicode letters/numbers, length >= 2, minus stopwords,
 * plus CJK bigrams for languages without spaces. Diacritics preserved.
 */
function significantTokens(text) {
  const normalized = normalize(text);
  const tokens = new Set();

  for (const word of normalized.match(/[\p{L}\p{N}_]{2,}/gu) ?? []) {
    if (!STOPWORDS.has(word)) tokens.add(word);
  }

  const cjk = Array.from(normalized.match(/[一-鿿]/g) ?? []);
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(`${cjk[i]}${cjk[i + 1]}`);
  }

  return [...tokens];
}

/**
 * Returns true if `content` is grounded in `sourceText`.
 * Graceful: empty/absent source text → true (cannot disprove).
 */
function isGrounded(content, sourceText, threshold = DEFAULT_THRESHOLD) {
  if (!sourceText || !String(sourceText).trim()) return true; // graceful skip

  const tokens = significantTokens(content);
  if (tokens.length === 0) return true; // nothing to evaluate → accept

  // Exact token-set overlap (NOT substring: avoids "is" matching inside "concise").
  const sourceSet = new Set(significantTokens(sourceText));
  const matched = tokens.filter((t) => sourceSet.has(t));
  return matched.length / tokens.length >= threshold;
}

/**
 * Partition records into {kept, dropped} by grounding.
 * Resolves each record's source_message_ids against idToText (a Map id->text).
 * Graceful: records with no ids, or ids that resolve to no text, are KEPT.
 */
function filterGrounded(records, idToText, threshold = DEFAULT_THRESHOLD) {
  const kept = [];
  const dropped = [];
  for (const rec of records) {
    const ids = Array.isArray(rec.source_message_ids) ? rec.source_message_ids : [];
    const sourceText = ids
      .map((id) => (idToText && idToText.get ? idToText.get(id) : ""))
      .filter((t) => typeof t === "string" && t.length > 0)
      .join("\n");
    if (isGrounded(rec.content, sourceText, threshold)) kept.push(rec);
    else dropped.push(rec);
  }
  return { kept, dropped };
}

module.exports = { isGrounded, significantTokens, filterGrounded, DEFAULT_THRESHOLD };
