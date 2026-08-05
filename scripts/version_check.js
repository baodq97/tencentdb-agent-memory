"use strict";
/**
 * Version compare + update-status — pure, so the "is there a newer tmem?" logic
 * is unit-testable without a network call. cli.js does the actual registry fetch
 * (fail-open) and the optional `npm i -g` and feeds the two version strings here.
 */

/** The npm package the CLI is published under (scoped: npm blocks bare "tmem"). */
const NPM_PKG = "@baodq97/tmem";

/** Numeric-aware x.y.z compare: >0 if a>b, <0 if a<b, 0 equal. Prerelease tags
 *  sort after their release only lexically — fine for this project's plain x.y.z. */
function cmpVersion(a, b) {
  const parts = (s) => String(s).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** {current, latest, updateAvailable} — updateAvailable only when latest is a
 *  real, strictly-greater version (a missing/unreachable latest is never "newer"). */
function updateStatus(current, latest) {
  const has = !!latest && latest !== "unknown";
  return { current, latest: has ? latest : null, updateAvailable: has && cmpVersion(latest, current) > 0 };
}

module.exports = { NPM_PKG, cmpVersion, updateStatus };
