// rma-site-snapshots — scripts/checks.mjs
// Pure helpers for the non-axe checks (font family). Kept out of snapshot.mjs so they can be
// unit-tested without launching a browser: `npm test`.

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
