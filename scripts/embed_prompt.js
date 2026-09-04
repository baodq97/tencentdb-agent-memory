"use strict";
/**
 * The EmbeddingGemma retrieval prompt template — ONE definition, shared by every
 * embed call site on both sides of the index.
 *
 * WHY THIS FILE EXISTS. Until now `embedding_service.js` embedded raw text for
 * queries AND documents, so the model's asymmetric retrieval mode was never used
 * and the two sides shared one symmetric representation. Measured on the live
 * 90-fact corpus (bench/embed_prefix_ab.json, 2026-09-04), that costs almost all
 * of the separation a floor needs:
 *
 *   arm A raw (shipped until now) : R@1 73.3%  R@5 96.7%  separation 0.009
 *   arm C prefixed, title=scene   : R@1 83.3%  R@5 100%   separation 0.071
 *
 * The retrieval gain is real, but the headline is separation: at 0.009 the
 * on-topic and off-topic top-1 populations are all but touching, so NO threshold
 * divides them and any floor that appears to work is fitted to its own sample.
 * The prefix is what makes a relevance floor a sound instrument at all.
 *
 * PRIMARY SOURCE for the strings (ai.google.dev EmbeddingGemma model card; the
 * HuggingFace config_sentence_transformers.json is gated and could not be read).
 * The card states prompts are *prepended* to the input:
 *
 *   retrieval query    : "task: search result | query: {content}"
 *   retrieval document : "title: {title | \"none\"} | text: {content}"
 *
 * The local GGUF carries no prompt template in its metadata, so nothing applies
 * one automatically — it has to be done here.
 *
 * PURE: strings in, strings out. No I/O, no model, no store. Importable from the
 * resident daemon, the hook path and the bench alike.
 */

/**
 * Stamped into every index built with this template, and checked before any
 * stored vector is compared against a fresh one.
 *
 * Cosine between a prefixed and an unprefixed vector is not a meaningful number —
 * it is not "a bit lower", it is a comparison between two different embeddings of
 * two different strings. So a mixed index does not degrade gracefully, it reports
 * confident nonsense. This constant is the only thing standing between a
 * half-migrated store and that. Bump it for ANY change that alters what gets
 * embedded: these prefixes, the truncation budget below, or the model itself.
 */
const EMBED_VERSION = "gemma-prefix-c-v1";

/**
 * Truncation budget, in CHARACTERS.
 *
 * Deliberately unchanged at 512 in the wave that introduced the prefix. It is
 * known to be the wrong unit — the model's window is 2048 TOKENS, and Vietnamese
 * diacritics split into more subwords per character than English, so 512 chars
 * bites earliest exactly where this store has the most text. Raising it is its own
 * wave with its own measured arm, because arm C's numbers above (and the floors
 * derived from them) were measured at 512 and are only valid at 512.
 *
 * `embedding_service.js` truncates at the same budget as a backstop. Prefixing
 * here first means the prefix is inside the budget, so that backstop never fires
 * on a correctly-built string and can never cut a prefix in half.
 */
const MAX_INPUT_CHARS = 512;

/** Retrieval-query prefix. The `{content}` slot is appended by withPrefix(). */
const QUERY_PREFIX = "task: search result | query: ";

/**
 * Retrieval-document prefix for a document titled `title`.
 *
 * The title slot is not decoration: arm C beat arm B (`title: none`) on
 * separation, 0.071 vs 0.060, purely by putting the scene name in it — a value
 * the store already had and was throwing away. Anything falsy falls back to the
 * model card's own sentinel, the literal string "none".
 */
function docPrefix(title) {
  return `title: ${title || "none"} | text: `;
}

/**
 * Prepend `prefix`, keeping the whole string inside MAX_INPUT_CHARS.
 *
 * THE CONTENT IS TRIMMED, NEVER THE PREFIX. Truncating a full-length string after
 * prepending would drop the tail of a long fact, which makes the prefix arm look
 * worse for a reason that is not the prefix; cutting into the prefix instead would
 * feed the model a malformed template. Both are silent. This ordering is the one
 * the offline A/B used (bench/embed_prefix_ab.js), so the shipped path and the
 * numbers it was calibrated on agree.
 */
function withPrefix(prefix, content) {
  const room = MAX_INPUT_CHARS - prefix.length;
  return prefix + String(content == null ? "" : content).slice(0, Math.max(0, room));
}

/** The exact string to embed for a retrieval QUERY. */
function queryText(content) {
  return withPrefix(QUERY_PREFIX, content);
}

/** The exact string to embed for a retrieval DOCUMENT titled `title`. */
function docText(content, title) {
  return withPrefix(docPrefix(title), content);
}

module.exports = {
  EMBED_VERSION,
  MAX_INPUT_CHARS,
  QUERY_PREFIX,
  docPrefix,
  withPrefix,
  queryText,
  docText,
};
