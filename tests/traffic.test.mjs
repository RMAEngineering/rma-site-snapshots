// rma-site-snapshots — tests/traffic.test.mjs
// Unit tests for scripts/traffic-lib.mjs (week math, query definitions, bucketing, flags, renderer). No network. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mondayOf, completeWeeks, weekEndOf, weekLabel, queryDefs, buildQueryUrl, normalizeHost, normalizePath, rowsByWeek, buildWeeks, computeFlags, renderMarkdown } from '../scripts/traffic-lib.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../traffic.config.json', import.meta.url), 'utf8'));
const row = (ts, visitors, pageviews, dim) => ({ timestamp: `${ts}T00:00:00.000Z`, visitors, pageviews, ...dim });

// ---------------------------------------------------------------- week math
test('mondayOf floors to Monday 00:00 UTC', () => {
  assert.equal(mondayOf('2026-11-01T22:00:00Z').toISOString(), '2026-10-26T00:00:00.000Z');   // Sunday evening
  assert.equal(mondayOf('2026-10-28T15:00:00Z').toISOString(), '2026-10-26T00:00:00.000Z');   // Wednesday
  assert.equal(mondayOf('2026-10-26T00:00:00Z').toISOString(), '2026-10-26T00:00:00.000Z');   // Monday itself
  assert.equal(mondayOf('2026-10-25T23:59:59.999Z').toISOString(), '2026-10-19T00:00:00.000Z');
});

test('completeWeeks: the 8 most recent complete Mon–Sun weeks, never the week in progress', () => {
  const w = completeWeeks('2026-11-01T22:00:00Z', 8);   // Sunday Nov 1: the week of Oct 26 is still running
  assert.deepEqual(w.weekStarts, ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
  assert.equal(w.since.toISOString(), '2026-08-31T00:00:00.000Z');
  assert.equal(w.until.toISOString(), '2026-10-25T23:59:59.999Z');     // last ms of the newest complete week, not Monday 00:00
  const m = completeWeeks('2026-11-02T00:00:00.000Z', 8);   // Monday 00:00 exactly: last week is complete now
  assert.equal(m.weekStarts[7], '2026-10-26');
  assert.equal(m.until.toISOString(), '2026-11-01T23:59:59.999Z');
  assert.equal(completeWeeks('2026-11-02T11:05:00Z', 8).weekStarts[7], '2026-10-26');   // the Monday 11:00 UTC schedule
  assert.equal(completeWeeks('2026-11-02T11:05:00Z', 2).weekStarts.length, 2);
  assert.equal(weekEndOf('2026-10-19'), '2026-10-25');
  assert.equal(weekLabel('2026-10-05'), 'Oct 5');
});

// ---------------------------------------------------------------- queries
test('queryDefs: US filter everywhere except the no-referrer-by-country query; never utm; by has at most 2 keys', () => {
  const q = queryDefs(cfg);
  assert.deepEqual(Object.keys(q), ['us', 'referrers', 'paths', 'countriesNoRef', 'chatgptPages']);
  for (const [k, d] of Object.entries(q)) {
    assert.ok(d.by.length >= 1 && d.by.length <= 2 && d.by[0] === 'week', k);
    assert.ok(!/utm/i.test(d.by.join()) && !/utm/i.test(d.filter || ''), k);
    if (k !== 'countriesNoRef') assert.match(d.filter, /country eq 'US'/, k);
  }
  assert.equal(q.countriesNoRef.filter, "referrerHostname eq ''");
  assert.equal(q.chatgptPages.filter, "country eq 'US' and referrerHostname eq 'chatgpt.com'");
  assert.deepEqual([q.referrers.limit, q.paths.limit, q.countriesNoRef.limit, q.chatgptPages.limit], [20, 60, 10, 20]);
});

test('buildQueryUrl repeats `by`, encodes the filter with %20 (no "+") and carries the ids and the ISO window', () => {
  const win = completeWeeks('2026-11-01T22:00:00Z', 8);
  const url = buildQueryUrl(cfg.vercel, queryDefs(cfg).referrers, win);
  assert.ok(url.startsWith('https://api.vercel.com/v1/query/web-analytics/visits/aggregate?'));
  assert.ok(url.includes('teamId=team_035xPAMeSLpAJV8bJITxjMtP&projectId=prj_zNoXiJrpzpACjqblulbPyFvfVOWp'));
  assert.ok(url.includes('since=2026-08-31T00%3A00%3A00.000Z&until=2026-10-25T23%3A59%3A59.999Z'));
  assert.ok(url.includes('&by=week&by=referrerHostname&'));
  assert.ok(url.includes("filter=country%20eq%20'US'"));
  assert.ok(!url.includes('+'));
  assert.ok(url.endsWith('&limit=20'));
  assert.ok(!buildQueryUrl(cfg.vercel, queryDefs(cfg).us, win).includes('limit='));
});

// ---------------------------------------------------------------- bucketing
test('normalizeHost / normalizePath', () => {
  assert.equal(normalizeHost('www.Google.com'), 'google.com');
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost(undefined), '');
  assert.equal(normalizePath('/contact-us/'), '/contact-us');
  assert.equal(normalizePath('/inventors?utm=x#top'), '/inventors');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
});

test('rowsByWeek keys rows by their Monday and drops rows outside the window', () => {
  const m = rowsByWeek([row('2026-10-12', 1, 1), row('2026-10-19', 2, 2), row('2026-10-26', 3, 3)], ['2026-10-12', '2026-10-19']);
  assert.deepEqual([...m.keys()], ['2026-10-12', '2026-10-19']);
  assert.equal(m.get('2026-10-12').length, 1);
  assert.equal(m.get('2026-10-19').length, 1);
  assert.deepEqual(rowsByWeek(null, ['2026-10-12']).get('2026-10-12'), []);
});

// the Oct 12 + Oct 19 rows exactly as Vercel returned them on Nov 1, 2026 (sanity numbers from the dashboard)
const WEEKS2 = ['2026-10-12', '2026-10-19'];
const REFERRERS = [
  ['2026-10-12', 85, 263, ''], ['2026-10-19', 58, 114, ''],
  ['2026-10-12', 73, 78, 'google.com'], ['2026-10-19', 64, 79, 'google.com'],
  ['2026-10-12', 1, 1, 'bing.com'], ['2026-10-19', 3, 3, 'bing.com'],
  ['2026-10-12', 2, 2, 'duckduckgo.com'], ['2026-10-19', 1, 1, 'duckduckgo.com'],
  ['2026-10-12', 0, 0, 'canvas.chaffey.edu'], ['2026-10-19', 1, 1, 'canvas.chaffey.edu'],
  ['2026-10-12', 1, 1, 'l.instagram.com'], ['2026-10-19', 0, 0, 'l.instagram.com'],
  ['2026-10-12', 1, 1, 'linkedin.com'], ['2026-10-19', 0, 0, 'linkedin.com'],
  ['2026-10-12', 0, 0, 'search.yahoo.com'], ['2026-10-19', 1, 1, 'search.yahoo.com'],
  ['2026-10-12', 0, 0, 'usc-excel.officeapps.live.com'], ['2026-10-19', 1, 1, 'usc-excel.officeapps.live.com'],
].map(([t, v, p, h]) => row(t, v, p, { referrerHostname: h }));
const COUNTRIES = [
  ['2026-10-12', 85, 263, 'US'], ['2026-10-19', 58, 114, 'US'], ['2026-10-12', 65, 67, 'SG'], ['2026-10-19', 41, 41, 'SG'],
  ['2026-10-12', 10, 10, 'CN'], ['2026-10-19', 16, 16, 'CN'], ['2026-10-12', 13, 36, 'Others'], ['2026-10-19', 9, 13, 'Others'],
  ['2026-10-12', 1, 2, 'IN'], ['2026-10-19', 4, 4, 'IN'], ['2026-10-12', 2, 2, 'BR'], ['2026-10-19', 2, 2, 'BR'],
  ['2026-10-12', 2, 2, 'CA'], ['2026-10-19', 1, 6, 'CA'], ['2026-10-12', 1, 1, 'PK'], ['2026-10-19', 2, 2, 'PK'],
  ['2026-10-12', 3, 3, 'VN'], ['2026-10-19', 0, 0, 'VN'], ['2026-10-12', 1, 1, 'EG'], ['2026-10-19', 1, 3, 'EG'],
  ['2026-10-12', 2, 2, 'ES'], ['2026-10-19', 0, 0, 'ES'],
].map(([t, v, p, c]) => row(t, v, p, { country: c }));
const PATHS = [
  ['/', 100, 150], ['/contact-us/', 12, 20], ['/contact-us', 3, 4], ['/inventors', 9, 12], ['/inventors/thank-you', 2, 2],
  ['/services/design-services', 5, 6], ['/industries', 4, 4], ['/faq', 2, 2], ['/blog/prototype-cost', 7, 8],
  ['/boston-product-development', 3, 3], ['/nyc-prototype-development', 1, 1], ['/industriesfoo', 1, 1], ['Others', 20, 25],
].map(([p, v, pv]) => row('2026-10-19', v, pv, { requestPath: p }));
const GPT = [row('2026-10-19', 1, 2, { requestPath: '/' }), row('2026-10-19', 0, 0, { requestPath: '/services' }), row('2026-10-12', 0, 0, { requestPath: '/' })];

test('buildWeeks reproduces the Nov 1 sanity numbers: US no-referrer 85/263 and 58/114, bot share from all countries', () => {
  const [a, b] = buildWeeks(WEEKS2, { us: [row('2026-10-12', 240, 420), row('2026-10-19', 195, 310)], referrers: REFERRERS, paths: PATHS, countriesNoRef: COUNTRIES, chatgptPages: GPT }, cfg);
  assert.deepEqual([a.weekStart, a.weekEnd, b.weekStart, b.weekEnd], ['2026-10-12', '2026-10-18', '2026-10-19', '2026-10-25']);
  assert.deepEqual(a.us, { visitors: 240, pageviews: 420 });
  assert.deepEqual(a.referrers[''], { visitors: 85, pageviews: 263 });
  assert.deepEqual(b.referrers[''], { visitors: 58, pageviews: 114 });
  assert.equal(a.referrers['google.com'].visitors, 73);
  assert.equal(b.referrers['google.com'].visitors, 64);
  assert.equal(a.referrers['chatgpt.com'].visitors, 0);             // absent from the rows: still a zero bucket
  assert.deepEqual(a.referrers.other, { visitors: 1, pageviews: 1 });   // l.instagram.com
  assert.deepEqual(b.referrers.other, { visitors: 3, pageviews: 3 });   // canvas + yahoo + officeapps
  assert.deepEqual(Object.keys(a.referrers), ['', 'google.com', 'chatgpt.com', 'bing.com', 'linkedin.com', 'duckduckgo.com', 'other']);
  assert.deepEqual(a.noReferrer, { total: 185, us: 85, nonUs: 100 });
  assert.equal(a.botShareNoReferrer, 0.541);
  assert.deepEqual(b.noReferrer, { total: 134, us: 58, nonUs: 76 });
  assert.equal(b.botShareNoReferrer, 0.567);
  assert.deepEqual(a.chatgptPages, []);                               // zero rows are not listed
  assert.deepEqual(b.chatgptPages, [{ path: '/', visitors: 1, pageviews: 2 }]);
});

test('buildWeeks groups paths: trailing slash merged, thank-you not an ad page, services/* and industries* deep, metro by pattern, Others kept apart', () => {
  const [, b] = buildWeeks(WEEKS2, { us: null, referrers: null, paths: PATHS, countriesNoRef: null, chatgptPages: null }, cfg);
  assert.deepEqual(b.pages['/contact-us'], { visitors: 15, pageviews: 24 });
  assert.equal(b.pages['/contact-us/'], undefined);
  assert.deepEqual(b.groups, {
    adPages:   { visitors: 24, pageviews: 36 },   // /contact-us 15 + /inventors 9
    deepPages: { visitors: 11, pageviews: 12 },   // design-services 5 + /industries 4 + /faq 2; not /industriesfoo
    thankYou:  { visitors: 2, pageviews: 2 },
    blog:      { visitors: 7, pageviews: 8 },
    metro:     { visitors: 4, pageviews: 4 },     // boston + nyc
  });
  assert.deepEqual(b.pathOverflow, { visitors: 20, pageviews: 25 });
  assert.equal(b.pages.Others, undefined);
  assert.equal(b.us, null);                        // failed queries leave null, not zero
  assert.equal(b.referrers, null);
  assert.equal(b.botShareNoReferrer, null);
  assert.equal(b.chatgptPages, null);
});

test('metro pattern matches every metro landing page in the Nov 1 sitemap and nothing else', () => {
  const [, b] = buildWeeks(WEEKS2, { us: null, referrers: null, countriesNoRef: null, chatgptPages: null, paths: [
    '/boston-product-development', '/chicago-product-development', '/denver-product-development', '/los-angeles-product-development',
    '/new-jersey-product-development', '/nyc-prototype-development', '/philadelphia-product-development',
    '/services/design-services', '/blog/how-to-choose-product-development-company', '/', '/inventors',
  ].map(p => row('2026-10-19', 1, 1, { requestPath: p })) }, cfg);
  assert.equal(b.groups.metro.visitors, 7);
});

// ---------------------------------------------------------------- flags
// 8 synthetic weeks; each spec gives the latest week's values and the 4 baseline weeks' value per metric
const mk = ({ us = 100, noref = 50, deep = 20, ad = 10, gpt = 0, bot = 0.1, ws = '2026-10-19' } = {}) => ({
  weekStart: ws, weekEnd: weekEndOf(ws), us: { visitors: us, pageviews: us * 2 },
  referrers: { '': { visitors: noref, pageviews: noref * 2 }, 'google.com': { visitors: 1, pageviews: 1 }, 'chatgpt.com': { visitors: gpt, pageviews: gpt }, 'bing.com': { visitors: 0, pageviews: 0 }, 'linkedin.com': { visitors: 0, pageviews: 0 }, 'duckduckgo.com': { visitors: 0, pageviews: 0 }, other: { visitors: 0, pageviews: 0 } },
  groups: { adPages: { visitors: ad, pageviews: ad }, deepPages: { visitors: deep, pageviews: deep }, thankYou: { visitors: 0, pageviews: 0 }, blog: { visitors: 0, pageviews: 0 }, metro: { visitors: 0, pageviews: 0 } },
  pages: { '/contact-us': { visitors: ad, pageviews: ad } }, pathOverflow: { visitors: 0, pageviews: 0 },
  noReferrer: { total: 100, us: Math.round(100 - bot * 100), nonUs: Math.round(bot * 100) }, botShareNoReferrer: bot, chatgptPages: [],
});
const STARTS = completeWeeks('2026-11-01T22:00:00Z', 8).weekStarts;
// weeks 0-2 are far history (ignored by the baseline), 3-6 the baseline, 7 the latest
const series = (metric, baseline, latest, far = baseline) => STARTS.map((ws, i) => mk({ ws, [metric]: i === 7 ? latest : (i >= 3 ? baseline : far) }));
const codes = flags => flags.map(f => f.code);

test('ratio flags fire at the threshold (at or below / at or above) and not one unit past it', () => {
  assert.deepEqual(codes(computeFlags(series('noref', 100, 75), cfg)), ['US_NOREF_DOWN']);
  assert.deepEqual(codes(computeFlags(series('noref', 100, 76), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('deep', 50, 30), cfg)), ['DEEP_PAGES_DOWN']);
  assert.deepEqual(codes(computeFlags(series('deep', 50, 31), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('ad', 50, 30), cfg)), ['AD_PAGES_DOWN']);
  assert.deepEqual(codes(computeFlags(series('ad', 50, 31), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('us', 100, 140), cfg)), ['TRAFFIC_UP']);
  assert.deepEqual(codes(computeFlags(series('us', 100, 139), cfg)), []);
  const f = computeFlags(series('noref', 100, 60), cfg)[0];
  assert.deepEqual({ ...f, text: undefined }, { code: 'US_NOREF_DOWN', latest: 60, avg: 100, ratio: 0.6, threshold: 0.75, baselineWeeks: 4, text: undefined });
  assert.equal(f.text, 'US_NOREF_DOWN: US no-referrer visitors 60, prior 4-week avg 100, ratio 0.6 (flag <= 0.75)');
});

test('the baseline is the 4 weeks before the latest, not the whole window', () => {
  assert.deepEqual(codes(computeFlags(series('noref', 100, 75, 1000), cfg)), ['US_NOREF_DOWN']);   // far history huge: irrelevant
  assert.deepEqual(codes(computeFlags(series('noref', 100, 76, 1), cfg)), []);
  assert.equal(computeFlags(series('noref', 100, 50, 1), cfg)[0].avg, 100);
});

test('a zero baseline never produces a ratio flag', () => {
  assert.deepEqual(codes(computeFlags(series('noref', 0, 0), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('deep', 0, 0), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('us', 0, 5), cfg)), ['DATA_GAP']);   // 0 US visitors in the baseline weeks is a gap, not a 140% jump
});

test('CHATGPT_ZERO needs two trailing zero weeks and an 8-week max of at least 3', () => {
  const gpt = values => STARTS.map((ws, i) => mk({ ws, gpt: values[i] }));
  assert.deepEqual(codes(computeFlags(gpt([0, 0, 0, 3, 1, 0, 0, 0]), cfg)), ['CHATGPT_ZERO']);
  assert.deepEqual(codes(computeFlags(gpt([3, 0, 0, 0, 0, 0, 0, 0]), cfg)), ['CHATGPT_ZERO']);   // the max can be anywhere in the window
  assert.deepEqual(codes(computeFlags(gpt([0, 0, 0, 3, 1, 0, 1, 0]), cfg)), []);                // only one trailing zero
  assert.deepEqual(codes(computeFlags(gpt([0, 0, 0, 2, 1, 0, 0, 0]), cfg)), []);                // max 2 < 3
  assert.deepEqual(codes(computeFlags(gpt([0, 0, 0, 0, 0, 0, 0, 0]), cfg)), []);                // never had ChatGPT traffic
  const f = computeFlags(gpt([0, 0, 0, 3, 1, 0, 0, 0]), cfg)[0];
  assert.equal(f.text, 'CHATGPT_ZERO: chatgpt.com visitors 0, 0 in the last 2 weeks; 8-week max 3 (flag >= 3)');
});

test('BOT_SPIKE: at or above 1.4x the prior 4-week average, or at or above 0.7 outright; the normal 0.45–0.57 range never fires', () => {
  assert.deepEqual(codes(computeFlags(series('bot', 0.4, 0.56), cfg)), ['BOT_SPIKE']);     // ratio exactly 1.4, below the absolute line
  assert.deepEqual(codes(computeFlags(series('bot', 0.4, 0.55), cfg)), []);                // 1.375x
  assert.deepEqual(codes(computeFlags(series('bot', 0.65, 0.7), cfg)), ['BOT_SPIKE']);     // ratio only 1.08, but 0.7 outright
  assert.deepEqual(codes(computeFlags(series('bot', 0.65, 0.69), cfg)), []);
  assert.deepEqual(codes(computeFlags(series('bot', 0.5, 0.7), cfg)), ['BOT_SPIKE']);      // both lines at once
  // the real Aug 31 – Oct 19 shares (Bot column of the Nov 1 branch run): baseline 0.46, 0.49, 0.45, 0.54, latest 0.567.
  // The old fixed 0.5 line fired here; 0.567 is 1.17x the average and below 0.7, so now it must not.
  const real = STARTS.map((ws, i) => mk({ ws, bot: [0.56, 0.48, 0.59, 0.46, 0.49, 0.45, 0.54, 0.567][i] }));
  assert.deepEqual(codes(computeFlags(real, cfg)), []);
  // no baseline shares: only the absolute line can fire
  const noBase = series('bot', 0.1, 0.6); for (const w of noBase.slice(0, 7)) { w.botShareNoReferrer = null; w.noReferrer = null; }
  assert.deepEqual(codes(computeFlags(noBase, cfg)), []);
  noBase[7].botShareNoReferrer = 0.75; noBase[7].noReferrer = { total: 100, us: 25, nonUs: 75 };
  assert.deepEqual(codes(computeFlags(noBase, cfg)), ['BOT_SPIKE']);
  assert.equal(computeFlags(noBase, cfg)[0].text, 'BOT_SPIKE: non-US share of no-referrer visitors 0.75 (75/100), prior 0-week avg n/a, ratio n/a (flag >= 1.4x avg or >= 0.7)');
  // unknown latest share never flags
  const unknown = series('bot', 0.1, 0.1); unknown[7].botShareNoReferrer = null; unknown[7].noReferrer = null;
  assert.deepEqual(codes(computeFlags(unknown, cfg)), []);
  const f = computeFlags(series('bot', 0.4, 0.8), cfg)[0];
  assert.equal(f.text, 'BOT_SPIKE: non-US share of no-referrer visitors 0.8 (80/100), prior 4-week avg 0.4, ratio 2 (flag >= 1.4x avg or >= 0.7)');
  assert.deepEqual({ latest: f.latest, avg: f.avg, ratio: f.ratio, ratioThreshold: f.ratioThreshold, absoluteThreshold: f.absoluteThreshold, baselineWeeks: f.baselineWeeks },
    { latest: 0.8, avg: 0.4, ratio: 2, ratioThreshold: 1.4, absoluteThreshold: 0.7, baselineWeeks: 4 });
});

test('DATA_GAP on a failed query or a week with 0 US visitors; nothing else wrong -> no flags at all', () => {
  assert.deepEqual(computeFlags(series('us', 100, 100), cfg), []);
  const gap = computeFlags(series('us', 100, 100), cfg, [{ query: 'referrers', message: 'HTTP 500' }]);
  assert.deepEqual(codes(gap), ['DATA_GAP']);
  assert.equal(gap[0].text, 'DATA_GAP: query referrers failed (HTTP 500)');
  assert.deepEqual(gap[0].failedQueries, ['referrers']);
  const weeks = series('us', 100, 100); weeks[1].us.visitors = 0;
  const z = computeFlags(weeks, cfg);
  assert.deepEqual(codes(z), ['DATA_GAP']);
  assert.equal(z[0].text, 'DATA_GAP: 0 US visitors in week 2026-09-07');
  const nullUs = series('us', 100, 100).map(w => ({ ...w, us: null }));   // us query failed: the error is the gap, null weeks are not "0 visitors"
  assert.deepEqual(codes(computeFlags(nullUs, cfg, [{ query: 'us', message: 'HTTP 401' }])), ['DATA_GAP']);
  assert.deepEqual(computeFlags(nullUs, cfg, [{ query: 'us', message: 'HTTP 401' }])[0].zeroUsWeeks, []);
});

test('flags come out in the documented order with DATA_GAP last', () => {
  const weeks = STARTS.map((ws, i) => mk({ ws, noref: i === 7 ? 10 : 100, deep: i === 7 ? 1 : 50, ad: i === 7 ? 1 : 50, us: i === 7 ? 500 : 100, gpt: i === 3 ? 3 : 0, bot: i === 7 ? 0.9 : 0.1 }));
  weeks[0].us.visitors = 0;
  assert.deepEqual(codes(computeFlags(weeks, cfg)), ['US_NOREF_DOWN', 'DEEP_PAGES_DOWN', 'CHATGPT_ZERO', 'AD_PAGES_DOWN', 'TRAFFIC_UP', 'BOT_SPIKE', 'DATA_GAP']);
});

// ---------------------------------------------------------------- traffic.md
test('renderMarkdown: header with count, 8 table rows, deep pages for the last 4 weeks, flags or "No flags", sources line', () => {
  const win = completeWeeks('2026-11-01T22:00:00Z', 8);
  const weeks = series('noref', 100, 60);
  weeks[7].pages = { '/contact-us': { visitors: 10, pageviews: 10 }, '/about-us': { visitors: 4, pageviews: 5 }, '/services/design-services': { visitors: 2, pageviews: 2 }, '/blog/x': { visitors: 9, pageviews: 9 } };
  weeks[6].pages = { '/about-us': { visitors: 3, pageviews: 3 } };
  const flags = computeFlags(weeks, cfg);
  const report = { generatedAt: '2026-11-02T11:07:12.000Z', window: { weeks: 8, since: win.since.toISOString(), until: win.until.toISOString(), weekStarts: win.weekStarts }, sources: { vercel: { ok: true, queriesOk: 5, queriesTotal: 5, errors: [] } }, flags, weeks };
  const md = renderMarkdown(report, cfg);
  const lines = md.trimEnd().split('\n');
  assert.equal(lines[0], '# Weekly traffic · generated 2026-11-02 11:07 UTC · 8 weeks Aug 31 to Oct 25 · 1 flag');
  assert.equal(lines[2], '## Vercel (US)');
  assert.equal(lines[3], '| Week | US vis | NoRef vis | NoRef pv | Google | ChatGPT | Deep | /contact-us | /inventors | Bot |');
  assert.equal(lines[4], '|---|---|---|---|---|---|---|---|---|---|');
  assert.equal(lines[5], '| Aug 31 | 100 | 100 | 200 | 1 | 0 | 20 | 10 | 0 | 10% |');
  assert.equal(lines[12], '| Oct 19 | 100 | 60 | 120 | 1 | 0 | 20 | 10 | 0 | 10% |');
  assert.ok(md.includes('## Deep pages, last 4 weeks (US visitors)\n| Page | Sep 28 | Oct 5 | Oct 12 | Oct 19 |\n|---|---|---|---|---|\n| /about-us | 0 | 0 | 3 | 4 |\n| /services/design-services | 0 | 0 | 0 | 2 |\n'), md);
  assert.ok(!md.includes('/blog/x'));
  assert.ok(md.includes('## Flags\n- US_NOREF_DOWN: US no-referrer visitors 60, prior 4-week avg 100, ratio 0.6 (flag <= 0.75)\n'));
  assert.ok(md.endsWith('\nSources: Vercel ok (5/5 queries) · GA4 not configured · Search Console not configured\n'));   // no Google sources in this report
  assert.ok(md.includes('## GA4 sessions by source (US)\nnot configured\n'));
  assert.ok(md.includes('## Search Console (US)\nnot configured\n'));

  const clean = renderMarkdown({ ...report, flags: [] }, cfg);
  assert.ok(clean.startsWith('# Weekly traffic · generated 2026-11-02 11:07 UTC · 8 weeks Aug 31 to Oct 25 · 0 flags\n'));
  assert.ok(clean.includes('## Flags\nNo flags\n'));

  const broken = renderMarkdown({ ...report, weeks: weeks.map(w => ({ ...w, referrers: null, noReferrer: null, botShareNoReferrer: null })), sources: { vercel: { ok: false, queriesOk: 4, queriesTotal: 5, errors: [{ query: 'referrers', message: 'HTTP 500' }] } } }, cfg);
  assert.ok(broken.includes('| Oct 19 | 100 | - | - | - | - | 20 | 10 | 0 | - |'));
  assert.ok(broken.endsWith('\nSources: Vercel error (referrers: HTTP 500) · GA4 not configured · Search Console not configured\n'));
});
