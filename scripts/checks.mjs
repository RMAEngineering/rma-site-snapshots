// rma-site-snapshots — scripts/checks.mjs
// Pure helpers for the non-axe checks (font family, sitewide-change rollup, failed-request carve-out). Kept out of
// snapshot.mjs so they can be unit-tested without launching a browser: `npm test`.

// ---------------------------------------------------------------- failed-request carve-out
// A failed request (any HTTP status >= 400 or any network error) whose URL contains one of the configured substrings is
// never a site fault and never flags: the Meta pixel's own error beacon (connect.facebook.net/log/error) answers 4xx by
// design. Plain substring match, case-sensitive. Unlike ignoreAbortedRequests this is not limited to net::ERR_ABORTED.
export const isIgnoredFailedRequest = (url, substrings) => (substrings || []).some(s => s && String(url || '').includes(s));

// ---------------------------------------------------------------- font check
// next/font renders the body family as `"__Inter_d8ebd1", "__Inter_Fallback_d8ebd1", system-ui, ...`: the first entry is
// the loaded face, the fallback entry only comes first when the real font is missing. On Oct 19 a stale font class left
// --font-inter undefined and the computed family was "Times New Roman" for 30 minutes — that is what this check catches.
// Only the FIRST family is compared, normalized: surrounding quotes, a leading "__" and a trailing "_<6 hex>" are
// stripped, so `"__Inter_d8ebd1"` -> `Inter` and `"Times New Roman"` -> `Times New Roman`.
export function firstFontFamily(raw) {
  const first = String(raw || '').split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '').trim().replace(/^__/, '').replace(/_[0-9a-f]{6}$/i, '').trim();
}

// null when the normalized first family starts with `expected` (case-insensitive); otherwise that family, for the flag
export function fontMismatch(raw, expected) {
  if (!expected) return null;
  const first = firstFontFamily(raw);
  return first.toLowerCase().startsWith(String(expected).toLowerCase()) ? null : first;
}

// one flag per distinct offending family, listing the viewports that show it:
//   font: body font-family starts with 'Times New Roman', expected 'Inter' (desktop, mobile)
// A view with no response (status 0) or no recorded family is skipped — it has its own HTTP/goto flag.
export function fontFlags(views, expected) {
  const byFamily = new Map();
  for (const [vn, vw] of Object.entries(views || {})) {
    if (!vw || vw.status === 0 || typeof vw.fontFamily !== 'string' || !vw.fontFamily) continue;
    const bad = fontMismatch(vw.fontFamily, expected);
    if (bad === null) continue;
    if (!byFamily.has(bad)) byFamily.set(bad, []);
    byFamily.get(bad).push(vn);
  }
  return [...byFamily].map(([fam, vns]) => `font: body font-family starts with '${fam}', expected '${expected}' (${vns.join(', ')})`);
}

// ---------------------------------------------------------------- sitewide-change rollup
// the per-view "changed" flag is built here so the rollup can recognise (and remove) exactly that flag and nothing else
export const changedFlag = (pctChanged, vn) => `changed ${pctChanged}% vs previous (${vn})`;
export const CHANGED_FLAG_RE = /^changed [\d.]+% vs previous \(/;

// When >= `share` of the compared pages (pages with a diff on at least one viewport) changed by >= diffPctWarn on either
// viewport, the change is sitewide — a header/footer/template edit, a font swap, a banner — and one line says so instead
// of a flag on every page. The per-page "changed" flags are removed; each view's diff numbers, the diff images and the
// "page height" flags stay. Below the share, or with fewer than `minPages` compared pages (a one-page run is not a
// sitewide statement), nothing changes. Mutates results[].flags; returns the summary or null.
//   { pages: changed pages, compared, share: pages/compared, desktopAvgPct, mobileAvgPct: mean pctChanged per viewport over the compared views }
export function rollupSitewideChange(results, { share = 0.8, diffPctWarn = 3, minPages = 2 } = {}) {
  const compared = results.filter(r => Object.values(r.views || {}).some(v => v?.diff));
  const changed = compared.filter(r => Object.values(r.views).some(v => v?.diff && v.diff.pctChanged >= diffPctWarn));
  if (compared.length < minPages || changed.length / compared.length < share) return null;
  const avg = vn => {
    const xs = compared.map(r => r.views[vn]?.diff?.pctChanged).filter(x => typeof x === 'number');
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
  };
  for (const r of changed) r.flags.splice(0, r.flags.length, ...r.flags.filter(f => !CHANGED_FLAG_RE.test(f)));
  return { pages: changed.length, compared: compared.length, share: Math.round(changed.length / compared.length * 1000) / 1000, desktopAvgPct: avg('desktop'), mobileAvgPct: avg('mobile') };
}
