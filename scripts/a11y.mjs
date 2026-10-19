// rma-site-snapshots — scripts/a11y.mjs
// Pure helpers for the axe results: the per-page summary shape and the sitewide (template-level) dedupe.
// Kept out of snapshot.mjs so they can be unit-tested without launching a browser.

// axe items ({ rule, impact, help, target, data, html }) -> the { byImpact, top } shape the report and flags consume
export function summarizeAxe(items) {
  const byImpact = {}, byRule = new Map();
  for (const it of items) {
    byImpact[it.impact] = (byImpact[it.impact] || 0) + 1;
    const r = byRule.get(it.rule) || { id: it.rule, impact: it.impact, nodes: 0, help: it.help };
    r.nodes++; byRule.set(it.rule, r);
  }
  return { byImpact, top: [...byRule.values()].sort((a, b) => b.nodes - a.nodes).slice(0, 5) };
}

// the dedupe key: same rule failing on the same selector
export const axeKey = it => `${it.rule}\u0000${it.target}`;

export const a11yFlag = ax => `a11y: ${ax.byImpact.critical || 0} critical / ${ax.byImpact.serious || 0} serious issues (${ax.top.slice(0, 2).map(t => t.id).join(', ')})`;

// A (rule, selector) pair that fails on >= `share` of the scanned pages is a layout issue (header/footer/nav or a shared
// component): report it once as "sitewide" and take it out of every page's a11y counts and flag line.
// Mutates results[].views.desktop.axe in place (byImpact/top/nodes/violations/items become page-only; the totals stay as
// totalByImpact + sitewideNodes) and pushes the per-page a11y flag where critical/serious page-only nodes remain.
// A pair must also be on at least `minPages` pages: "sitewide" means repeated, so a one- or two-page run cannot promote
// a node seen once (1/2 would otherwise pass the 50% share).
// Returns { sitewideA11y, axePagesScanned }.
export function dedupeSitewideA11y(results, share = 0.5, minPages = 2) {
  const axePages = results.filter(r => Array.isArray(r.views?.desktop?.axe?.items));
  const seen = new Map();
  for (const r of axePages) {
    const uniq = new Map();
    for (const it of r.views.desktop.axe.items) if (!uniq.has(axeKey(it))) uniq.set(axeKey(it), it);
    for (const [k, it] of uniq) {
      const s = seen.get(k) || { rule: it.rule, impact: it.impact, target: it.target, help: it.help, data: it.data, html: it.html, pages: [] };
      s.pages.push(r.path); seen.set(k, s);
    }
  }
  const sitewideA11y = [...seen.entries()]
    .filter(([, s]) => s.pages.length >= minPages && s.pages.length / axePages.length >= share)
    .sort((a, b) => b[1].pages.length - a[1].pages.length)
    .map(([key, { pages: on, ...s }]) => ({ key, ...s, pageCount: on.length, pagesScanned: axePages.length, missingFrom: axePages.map(r => r.path).filter(p => !on.includes(p)) }));
  const sitewideKeys = new Set(sitewideA11y.map(s => s.key));
  for (const r of axePages) {
    const ax = r.views.desktop.axe;
    const pageItems = ax.items.filter(it => !sitewideKeys.has(axeKey(it)));
    Object.assign(ax, { totalByImpact: ax.byImpact, sitewideNodes: ax.items.length - pageItems.length, ...summarizeAxe(pageItems),
      nodes: pageItems.length, violations: new Set(pageItems.map(it => it.rule)).size, items: pageItems });
    if (ax.byImpact.critical || ax.byImpact.serious) (r.flags ??= []).push(a11yFlag(ax));
  }
  return { sitewideA11y, axePagesScanned: axePages.length };
}
