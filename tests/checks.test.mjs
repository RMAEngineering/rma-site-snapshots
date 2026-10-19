// rma-site-snapshots — tests/checks.test.mjs
// Unit tests for the pure helpers in scripts/checks.mjs (no browser). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstFontFamily, fontMismatch, fontFlags, changedFlag, CHANGED_FLAG_RE, rollupSitewideChange, isIgnoredFailedRequest } from '../scripts/checks.mjs';

const NEXT_INTER = '"__Inter_d8ebd1", "__Inter_Fallback_d8ebd1", system-ui, -apple-system, sans-serif';

// ---------------------------------------------------------------- font check
test('firstFontFamily strips quotes, the next/font "__" prefix and the "_<6 hex>" hash', () => {
  assert.equal(firstFontFamily(NEXT_INTER), 'Inter');
  assert.equal(firstFontFamily("'__Inter_d8ebd1', sans-serif"), 'Inter');
  assert.equal(firstFontFamily('__Inter_Fallback_d8ebd1, sans-serif'), 'Inter_Fallback');   // fallback face first = font missing
  assert.equal(firstFontFamily('"Times New Roman"'), 'Times New Roman');                    // the Oct 19 incident value
  assert.equal(firstFontFamily('Inter, sans-serif'), 'Inter');
  assert.equal(firstFontFamily('  "Inter_abc12"  , serif'), 'Inter_abc12');                 // 5 hex chars: not a next/font hash, kept
  assert.equal(firstFontFamily(''), '');
  assert.equal(firstFontFamily(null), '');
});

test('fontMismatch is case-insensitive and prefix-based', () => {
  assert.equal(fontMismatch(NEXT_INTER, 'Inter'), null);
  assert.equal(fontMismatch(NEXT_INTER, 'inter'), null);
  assert.equal(fontMismatch('"Inter Variable", sans-serif', 'Inter'), null);
  assert.equal(fontMismatch('"Times New Roman"', 'Inter'), 'Times New Roman');
  assert.equal(fontMismatch(NEXT_INTER, 'Georgia'), 'Inter');
  assert.equal(fontMismatch('"Times New Roman"', ''), null);                                // no expectedFont: check disabled
});

test('fontFlags merges viewports per offending family and skips views without a response', () => {
  const ok = { desktop: { status: 200, fontFamily: NEXT_INTER }, mobile: { status: 200, fontFamily: NEXT_INTER } };
  assert.deepEqual(fontFlags(ok, 'Inter'), []);
  const tnr = { desktop: { status: 200, fontFamily: '"Times New Roman"' }, mobile: { status: 200, fontFamily: '"Times New Roman"' } };
  assert.deepEqual(fontFlags(tnr, 'Inter'), ["font: body font-family starts with 'Times New Roman', expected 'Inter' (desktop, mobile)"]);
  assert.deepEqual(fontFlags(ok, 'Georgia'), ["font: body font-family starts with 'Inter', expected 'Georgia' (desktop, mobile)"]);
  const mixed = { desktop: { status: 200, fontFamily: NEXT_INTER }, mobile: { status: 200, fontFamily: 'Georgia, serif' } };
  assert.deepEqual(fontFlags(mixed, 'Inter'), ["font: body font-family starts with 'Georgia', expected 'Inter' (mobile)"]);
  const dead = { desktop: { status: 0, fontFamily: '"Times New Roman"' }, mobile: { status: 200, fontFamily: null } };
  assert.deepEqual(fontFlags(dead, 'Inter'), []);
  assert.deepEqual(fontFlags(tnr, ''), []);
});

// ---------------------------------------------------------------- sitewide-change rollup
// a page with diffs: d/m = pctChanged per viewport (null = no previous file for that view); flags as snapshot.mjs pushes them
const page = (path, d, m, extra = []) => {
  const views = {};
  if (d !== undefined) views.desktop = { diff: d === null ? null : { pctChanged: d, heightChange: 0 } };
  if (m !== undefined) views.mobile = { diff: m === null ? null : { pctChanged: m, heightChange: 0 } };
  const flags = [...extra];
  for (const [vn, v] of Object.entries(views)) if (v.diff && v.diff.pctChanged >= 3) flags.push(changedFlag(v.diff.pctChanged, vn));
  return { path, views, flags };
};

test('changedFlag text is what CHANGED_FLAG_RE recognises, and nothing else', () => {
  assert.equal(changedFlag(12.4, 'desktop'), 'changed 12.4% vs previous (desktop)');
  assert.ok(CHANGED_FLAG_RE.test(changedFlag(3, 'mobile')));
  assert.ok(!CHANGED_FLAG_RE.test('page height +12% vs previous (desktop)'));
  assert.ok(!CHANGED_FLAG_RE.test('font: body font-family starts with \'Georgia\', expected \'Inter\' (desktop)'));
});

test('rollupSitewideChange: below the share nothing changes', () => {
  const results = [page('/', 10, 10), page('/a', 0.2, 0.1), page('/b', 5, 0), page('/c', 0, 0), page('/d', 0.3, 0.2)];   // 2/5 = 40%
  assert.equal(rollupSitewideChange(results, { share: 0.8, diffPctWarn: 3 }), null);
  assert.deepEqual(results[0].flags, ['changed 10% vs previous (desktop)', 'changed 10% vs previous (mobile)']);
  assert.deepEqual(results[2].flags, ['changed 5% vs previous (desktop)']);
});

test('rollupSitewideChange: at the share, one summary and the per-page "changed" flags are gone', () => {
  const results = [
    page('/', 20, 30, ['page height +12% vs previous (desktop)']),
    page('/a', 10, 0.5),                       // changed on desktop only still counts as a changed page
    page('/b', 0.5, 4),
    page('/c', 6, 8, ['2 H1s']),
    page('/d', 0.2, 0.1),                      // the one unchanged page: 4/5 = 80%
    page('/new', null, null),                  // no previous files: not compared, not counted
  ];
  const s = rollupSitewideChange(results, { share: 0.8, diffPctWarn: 3 });
  assert.deepEqual(s, { pages: 4, compared: 5, share: 0.8, desktopAvgPct: 7.3, mobileAvgPct: 8.5 });
  assert.deepEqual(results[0].flags, ['page height +12% vs previous (desktop)']);   // height flag kept
  assert.deepEqual(results[1].flags, []);
  assert.deepEqual(results[2].flags, []);
  assert.deepEqual(results[3].flags, ['2 H1s']);                                   // unrelated flags kept
  assert.deepEqual(results[4].flags, []);
  assert.equal(results[0].views.desktop.diff.pctChanged, 20);                      // diff numbers untouched
});

test('rollupSitewideChange: a one-page run never claims a sitewide change', () => {
  const results = [page('/', 50, 50)];
  assert.equal(rollupSitewideChange(results, { share: 0.8, diffPctWarn: 3 }), null);
  assert.equal(results[0].flags.length, 2);
  assert.equal(rollupSitewideChange([], { share: 0.8 }), null);
  assert.equal(rollupSitewideChange([page('/', null, null), page('/a', null, null)], { share: 0.8 }), null);   // nothing compared
});

// ---------------------------------------------------------------- failed-request carve-out
test('isIgnoredFailedRequest is a plain substring match on the URL, independent of status or error', () => {
  const list = ['connect.facebook.net/log/error'];
  assert.ok(isIgnoredFailedRequest('https://connect.facebook.net/log/error?id=123&ev=PageView', list));
  assert.ok(isIgnoredFailedRequest('https://connect.facebook.net/log/error', list));
  assert.ok(!isIgnoredFailedRequest('https://connect.facebook.net/en_US/fbevents.js', list));
  assert.ok(!isIgnoredFailedRequest('https://www.facebook.com/tr?id=1', list));
  assert.ok(!isIgnoredFailedRequest('https://www.rma-engineering.com/_next/static/chunks/app.js', list));
  assert.ok(!isIgnoredFailedRequest('https://connect.facebook.net/log/error', []));
  assert.ok(!isIgnoredFailedRequest('https://connect.facebook.net/log/error', undefined));
  assert.ok(!isIgnoredFailedRequest('https://connect.facebook.net/log/error', ['']));       // an empty entry never matches everything
});

test('rollupSitewideChange: SIMULATE_CHANGED-style input (every view 100%)', () => {
  const results = ['/', '/contact-us', '/inventors', '/blog/x'].map(p => page(p, 100, 100));
  const s = rollupSitewideChange(results, { share: 0.8, diffPctWarn: 3 });
  assert.deepEqual(s, { pages: 4, compared: 4, share: 1, desktopAvgPct: 100, mobileAvgPct: 100 });
  assert.ok(results.every(r => r.flags.length === 0));
});
