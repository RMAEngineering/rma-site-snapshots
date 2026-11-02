// rma-site-snapshots — tests/traffic-google.test.mjs
// Unit tests for the GA4 + Search Console parts of scripts/traffic-lib.mjs: date -> Monday-week bucketing, source /
// medium buckets, weighted Search Console weeks and the provisional mark, top-query movers, request bodies, the five
// Google flags and the extra traffic.md sections. No network. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { completeWeeks, weekEndOf, weekOfDate, ga4Date, normalizeGa4, ga4Bucket, ga4Buckets, buildGa4Weeks, ga4Provisional, leadsOf, isProvisional, buildGscWeeks, topQueryMovers,
  ga4SourcesRequest, ga4EventsRequest, gscRequest, computeFlags, computeFlagsAndInfo, renderMarkdown } from '../scripts/traffic-lib.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../traffic.config.json', import.meta.url), 'utf8'));
const WEEKS2 = ['2026-10-12', '2026-10-19'];

// ---------------------------------------------------------------- week math for daily rows
test('weekOfDate / ga4Date: a day maps to its Monday; GA4 YYYYMMDD becomes ISO', () => {
  assert.equal(weekOfDate('2026-10-18'), '2026-10-12');   // Sunday belongs to the week that started Monday Oct 12
  assert.equal(weekOfDate('2026-10-19'), '2026-10-19');
  assert.equal(weekOfDate('2026-10-25'), '2026-10-19');
  assert.equal(ga4Date('20261019'), '2026-10-19');
  assert.equal(ga4Date('2026-10-19'), '2026-10-19');       // already ISO: untouched
  assert.equal(weekOfDate(ga4Date('20261101')), '2026-10-26');
});

test('isProvisional: the newest week stays provisional until its last day + lag is behind the run date', () => {
  assert.equal(isProvisional('2026-10-26', '2026-11-02T11:05:00Z', 3), true);    // Monday run: Nov 1 + 3 = Nov 4 >= Nov 2
  assert.equal(isProvisional('2026-10-26', '2026-11-04T23:00:00Z', 3), true);    // Wednesday: still within the lag
  assert.equal(isProvisional('2026-10-26', '2026-11-05T00:30:00Z', 3), false);   // Thursday: final
  assert.equal(isProvisional('2026-10-19', '2026-11-02T11:05:00Z', 3), false);   // the week before is final on the Monday run
});

// ---------------------------------------------------------------- GA4
const GA4_SOURCES = { dimensionHeaders: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' }], metricHeaders: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }], rows: [
  ['20261013', 'google', 'cpc', '5', '4', '1'], ['20261014', 'google', 'organic', '7', '6', '0'],
  ['20261020', 'www.linkedin.com', 'referral', '2', '2', '0'], ['20261021', 'chatgpt.com', 'referral', '3', '3', '1'],
  ['20261022', '(direct)', '(none)', '4', '4', '0'], ['20261022', 'l.facebook.com', 'referral', '1', '1', '0'],
  ['20261101', 'google', 'organic', '99', '99', '9'],   // outside the window: dropped
].map(([d, s, m, a, b, c]) => ({ dimensionValues: [{ value: d }, { value: s }, { value: m }], metricValues: [{ value: a }, { value: b }, { value: c }] })), rowCount: 7 };
const GA4_EVENTS = { dimensionHeaders: [{ name: 'date' }, { name: 'eventName' }], metricHeaders: [{ name: 'eventCount' }], rows: [
  ['20261013', 'form_submit', '2'], ['20261020', 'generate_lead', '1'], ['20261020', 'unknown_event', '9'],
].map(([d, e, n]) => ({ dimensionValues: [{ value: d }, { value: e }], metricValues: [{ value: n }] })) };

test('normalizeGa4 turns header-ordered rows into objects with numeric metrics; no rows -> []', () => {
  const rows = normalizeGa4(GA4_SOURCES);
  assert.deepEqual(rows[0], { date: '20261013', sessionSource: 'google', sessionMedium: 'cpc', sessions: 5, totalUsers: 4, keyEvents: 1 });
  assert.equal(rows.length, 7);
  assert.deepEqual(normalizeGa4({ dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }] }), []);   // GA4 omits `rows` when empty
});

test('ga4Bucket keeps the listed source/mediums, folds any linkedin source, everything else is other', () => {
  assert.equal(ga4Bucket('google', 'cpc', cfg), 'google/cpc');
  assert.equal(ga4Bucket('google', 'organic', cfg), 'google/organic');
  assert.equal(ga4Bucket('(direct)', '(none)', cfg), '(direct)/(none)');
  assert.equal(ga4Bucket('chatgpt.com', 'referral', cfg), 'chatgpt.com/referral');
  assert.equal(ga4Bucket('bing', 'organic', cfg), 'bing/organic');
  assert.equal(ga4Bucket('www.linkedin.com', 'referral', cfg), 'linkedin');
  assert.equal(ga4Bucket('LinkedIn', 'social', cfg), 'linkedin');
  assert.equal(ga4Bucket('l.facebook.com', 'referral', cfg), 'other');
  assert.equal(ga4Bucket('google', 'organic-ish', cfg), 'other');
  // GA4 labels ChatGPT sessions chatgpt.com / ai-assistant (seen live Nov 1, 2026; ChatGPT appends utm_source=chatgpt.com): same bucket
  assert.equal(ga4Bucket('chatgpt.com', 'ai-assistant', cfg), 'chatgpt.com/referral');
  assert.equal(ga4Bucket('chatgpt.com', '(not set)', cfg), 'chatgpt.com/referral');
  assert.equal(ga4Bucket('ChatGPT', 'referral', cfg), 'chatgpt.com/referral');
  assert.deepEqual(ga4Buckets(cfg), ['google/cpc', 'google/organic', '(direct)/(none)', 'chatgpt.com/referral', 'bing/organic', 'linkedin', 'other']);   // no duplicate for the shared key
});

test('buildGa4Weeks keeps the raw top source/medium pairs per week as a diagnostic', () => {
  const rows = normalizeGa4(GA4_SOURCES).concat([{ date: '20261021', sessionSource: 'chatgpt.com', sessionMedium: '(not set)', sessions: 6, totalUsers: 6, keyEvents: 0 }]);
  const [a, b] = buildGa4Weeks(WEEKS2, { sources: rows, events: null }, cfg);
  assert.deepEqual(a.topSources, [{ sourceMedium: 'google/organic', sessions: 7 }, { sourceMedium: 'google/cpc', sessions: 5 }]);
  assert.deepEqual(b.topSources[0], { sourceMedium: 'chatgpt.com/(not set)', sessions: 6 });
  assert.equal(b.bySource['chatgpt.com/referral'].sessions, 9);   // 3 referral + 6 (not set)
  assert.equal(b.sessions, 16);
  assert.equal(b.events, null);
  const [, c] = buildGa4Weeks(WEEKS2, { sources: rows, events: null }, { ...cfg, ga4: { ...cfg.ga4, topSources: 2 } });
  assert.equal(c.topSources.length, 2);
});

test('buildGa4Weeks sums by Monday week and bucket, counts only the configured events, nulls what did not run', () => {
  const [a, b] = buildGa4Weeks(WEEKS2, { sources: normalizeGa4(GA4_SOURCES), events: normalizeGa4(GA4_EVENTS) }, cfg);
  assert.deepEqual([a.sessions, a.users, a.keyEvents], [12, 10, 1]);
  assert.deepEqual(a.bySource['google/cpc'], { sessions: 5, users: 4, keyEvents: 1 });
  assert.deepEqual(a.bySource['google/organic'], { sessions: 7, users: 6, keyEvents: 0 });
  assert.deepEqual(a.bySource.linkedin, { sessions: 0, users: 0, keyEvents: 0 });
  assert.deepEqual([b.sessions, b.users, b.keyEvents], [10, 10, 1]);
  assert.equal(b.bySource.linkedin.sessions, 2);
  assert.equal(b.bySource['chatgpt.com/referral'].sessions, 3);
  assert.equal(b.bySource['(direct)/(none)'].sessions, 4);
  assert.equal(b.bySource.other.sessions, 1);
  assert.deepEqual(a.events, { form_submit: 2, form_step2_complete: 0, booking_confirmed: 0, generate_lead: 0, idea_submit: 0 });
  assert.deepEqual(b.events, { form_submit: 0, form_step2_complete: 0, booking_confirmed: 0, generate_lead: 1, idea_submit: 0 });   // unknown_event ignored
  assert.equal(a.provisional, false);   // no `now` given: nothing is provisional
  assert.equal(a.leads, 0); assert.equal(b.leads, 0);   // generate_lead is not a lead event
  assert.equal(leadsOf({ form_step2_complete: 2, booking_confirmed: 1, idea_submit: 3, generate_lead: 9, form_submit: 7 }, cfg.ga4.leadEvents), 6);
  assert.equal(leadsOf(null, cfg.ga4.leadEvents), null);
  assert.equal(leadsOf({}, cfg.ga4.leadEvents), 0);
  const [c] = buildGa4Weeks(WEEKS2, { sources: null, events: normalizeGa4(GA4_EVENTS) }, cfg);
  assert.equal(c.sessions, null); assert.equal(c.bySource, null); assert.equal(c.events.form_submit, 2);
  assert.deepEqual(buildGa4Weeks(WEEKS2, { sources: null, events: null }, cfg), [null, null]);   // not configured
});

test('ga4 request bodies: US filter, the right dimensions/metrics, the window as dates, events via inListFilter, no utm', () => {
  const win = completeWeeks('2026-11-01T22:00:00Z', 8);
  const s = ga4SourcesRequest(win, cfg);
  assert.deepEqual(s.dateRanges, [{ startDate: '2026-08-31', endDate: '2026-10-25' }]);
  assert.deepEqual(s.dimensions.map(d => d.name), ['date', 'sessionSource', 'sessionMedium']);
  assert.deepEqual(s.metrics.map(m => m.name), ['sessions', 'totalUsers', 'keyEvents']);
  assert.deepEqual(s.dimensionFilter, { filter: { fieldName: 'countryId', stringFilter: { matchType: 'EXACT', value: 'US' } } });
  assert.equal(s.limit, '100000');
  const e = ga4EventsRequest(win, cfg);
  assert.deepEqual(e.dimensions.map(d => d.name), ['date', 'eventName']);
  assert.deepEqual(e.metrics.map(m => m.name), ['eventCount']);
  assert.deepEqual(e.dimensionFilter.andGroup.expressions[1].filter, { fieldName: 'eventName', inListFilter: { values: ['form_submit', 'form_step2_complete', 'booking_confirmed', 'generate_lead', 'idea_submit'] } });
  assert.ok(!JSON.stringify([s, e]).includes('utm'));
});

// ---------------------------------------------------------------- Search Console
const day = (d, clicks, impressions, position) => ({ keys: [d], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('buildGscWeeks: weekly clicks / impressions, impression-weighted position, brand merge, provisional mark', () => {
  const daily = { rows: [day('2026-10-12', 10, 100, 5), day('2026-10-13', 20, 300, 9), day('2026-10-19', 1, 50, 12), day('2026-10-05', 99, 999, 1)] };
  const brand = [day('2026-10-12', 8, 40, 1.2), day('2026-10-20', 2, 10, 1.5)];
  const [a, b] = buildGscWeeks(WEEKS2, { daily, brandDaily: brand }, cfg, '2026-10-26T11:05:00Z');
  assert.deepEqual({ clicks: a.clicks, impressions: a.impressions, position: a.position, ctr: a.ctr }, { clicks: 30, impressions: 400, position: 8, ctr: 0.075 });   // (5*100 + 9*300) / 400
  assert.deepEqual({ clicks: b.clicks, impressions: b.impressions, position: b.position }, { clicks: 1, impressions: 50, position: 12 });
  assert.deepEqual(a.brand, { clicks: 8, impressions: 40 });
  assert.deepEqual(b.brand, { clicks: 2, impressions: 10 });
  assert.equal(a.provisional, false);
  assert.equal(b.provisional, true);     // Oct 25 + 3 days >= Oct 26
  assert.deepEqual([a.weekStart, a.weekEnd], ['2026-10-12', '2026-10-18']);
  const [c] = buildGscWeeks(WEEKS2, { daily: null, brandDaily: brand }, cfg, '2026-10-26T11:05:00Z');
  assert.deepEqual({ clicks: c.clicks, impressions: c.impressions, position: c.position }, { clicks: null, impressions: null, position: null });
  assert.equal(c.brand.impressions, 40);
  const [d] = buildGscWeeks(WEEKS2, { daily, brandDaily: null }, cfg, '2026-10-26T11:05:00Z');
  assert.equal(d.brand, null);
  const [e] = buildGscWeeks(['2026-10-12'], { daily: { rows: [] }, brandDaily: null }, cfg, '2026-10-26T11:05:00Z');
  assert.deepEqual({ clicks: e.clicks, impressions: e.impressions, position: e.position }, { clicks: 0, impressions: 0, position: null });
});

test('topQueryMovers: top N of the latest week by impressions with prior numbers; movers over both weeks\' top N', () => {
  const q = (query, impressions, clicks) => ({ keys: [query], clicks, impressions, ctr: 0, position: 3 });
  const latest = { rows: [q('a', 100, 10), q('b', 80, 5), q('c', 60, 1), q('d', 10, 0)] };
  const prior = [q('a', 50, 4), q('b', 90, 6), q('e', 200, 20), q('c', 0, 0)];
  const t = topQueryMovers(latest, prior, { gsc: { topQueries: 3, movers: 2 } });
  assert.deepEqual(t.rows, [
    { query: 'a', impressions: 100, clicks: 10, prior: 50, priorClicks: 4, delta: 50 },
    { query: 'b', impressions: 80, clicks: 5, prior: 90, priorClicks: 6, delta: -10 },
    { query: 'c', impressions: 60, clicks: 1, prior: 0, priorClicks: 0, delta: 60 },
  ]);
  assert.deepEqual(t.up.map(r => [r.query, r.delta]), [['c', 60], ['a', 50]]);
  assert.deepEqual(t.down.map(r => [r.query, r.delta]), [['e', -200], ['b', -10]]);   // e fell out of the top 3 entirely
  assert.deepEqual(topQueryMovers(null, null, cfg), { rows: [], up: [], down: [] });
  assert.equal(topQueryMovers({ rows: Array.from({ length: 40 }, (_, i) => q(`q${i}`, 40 - i, 0)) }, [], cfg).rows.length, 25);
});

test('gsc request bodies: country usa, dataState all, brand regex only when asked, one-week query range', () => {
  const r = gscRequest({ start: '2026-07-06', end: '2026-10-25' }, { dimensions: ['date'] }, cfg);
  assert.deepEqual(r, { startDate: '2026-07-06', endDate: '2026-10-25', dimensions: ['date'], dimensionFilterGroups: [{ filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }], rowLimit: 1000, dataState: 'all' });
  const b = gscRequest({ start: '2026-07-06', end: '2026-10-25' }, { dimensions: ['date'], brand: true }, cfg);
  assert.deepEqual(b.dimensionFilterGroups[0].filters[1], { dimension: 'query', operator: 'includingRegex', expression: '(?i)rma eng|rma-eng' });
  const t = gscRequest({ start: '2026-10-19', end: weekEndOf('2026-10-19') }, { dimensions: ['query'], rowLimit: 500 }, cfg);
  assert.deepEqual([t.startDate, t.endDate, t.dimensions, t.rowLimit], ['2026-10-19', '2026-10-25', ['query'], 500]);
});

// ---------------------------------------------------------------- flags
const STARTS = completeWeeks('2026-11-01T22:00:00Z', 8).weekStarts;
const vw = (ws, { us = 100, organic = 20, chatgpt = 5, sessions = 120, ga4 = true } = {}) => ({
  weekStart: ws, weekEnd: weekEndOf(ws), us: { visitors: us, pageviews: us * 2 }, referrers: null, groups: null, pages: null, pathOverflow: null, noReferrer: null, botShareNoReferrer: null, chatgptPages: null,
  ga4: ga4 ? { sessions, users: sessions, keyEvents: 1, bySource: { 'google/organic': { sessions: organic, users: organic, keyEvents: 0 }, 'chatgpt.com/referral': { sessions: chatgpt, users: chatgpt, keyEvents: 0 } }, events: {}, leads: 0 } : null,
});
// weeks with GA4 events (and the derived leads): `values` for every week, `latestOnly` overrides for the newest
const withEvents = (values, latestOnly = {}, latestIndex = 7) => STARTS.map((ws, i) => {
  const w = vw(ws);
  w.ga4.events = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, i === latestIndex ? (latestOnly[k] ?? v) : v]));
  w.ga4.leads = leadsOf(w.ga4.events, cfg.ga4.leadEvents);
  return w;
});
const gw = (ws, { impressions = 1000, brand = 100 } = {}) => ({ weekStart: ws, weekEnd: weekEndOf(ws), clicks: 10, impressions, ctr: 0.01, position: 8, brand: { clicks: 5, impressions: brand }, provisional: false });
// weeks 0-2 far history, 3-6 the 4-week baseline, 7 the latest
const vseries = (metric, baseline, latest) => STARTS.map((ws, i) => vw(ws, { [metric]: i === 7 ? latest : baseline }));
const gseries = (metric, baseline, latest) => completeWeeks('2026-11-01T22:00:00Z', 16).weekStarts.map((ws, i) => gw(ws, { [metric]: i === 15 ? latest : baseline }));
const codes = flags => flags.map(f => f.code);

test('BRAND_IMPR_DOWN and GSC_IMPR_DOWN fire at the threshold on the 16-week Search Console series', () => {
  assert.deepEqual(codes(computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: gseries('brand', 100, 50) })), ['BRAND_IMPR_DOWN']);
  assert.deepEqual(codes(computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: gseries('brand', 100, 51) })), []);
  assert.deepEqual(codes(computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: gseries('impressions', 1000, 700) })), ['GSC_IMPR_DOWN']);
  assert.deepEqual(codes(computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: gseries('impressions', 1000, 701) })), []);
  const f = computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: gseries('brand', 100, 40) })[0];
  assert.equal(f.text, 'BRAND_IMPR_DOWN: brand impressions 40, prior 4-week avg 100, ratio 0.4 (flag <= 0.5)');
  assert.deepEqual(codes(computeFlags(vseries('us', 100, 100), cfg, [], { gscWeeks: null })), []);   // not configured
});

test('ORGANIC_DOWN needs a 4-week average of at least 10; CHATGPT_DOWN at least 4', () => {
  assert.deepEqual(codes(computeFlags(vseries('organic', 10, 6), cfg)), ['ORGANIC_DOWN']);    // 0.6 at avg 10
  assert.deepEqual(codes(computeFlags(vseries('organic', 10, 7), cfg)), []);
  assert.deepEqual(codes(computeFlags(vseries('organic', 9, 0), cfg)), []);                  // avg 9 < 10: a trickle, not a collapse
  assert.deepEqual(codes(computeFlags(vseries('chatgpt', 4, 2), cfg)), ['CHATGPT_DOWN']);     // 0.5 at avg 4
  assert.deepEqual(codes(computeFlags(vseries('chatgpt', 4, 3), cfg)), []);
  assert.deepEqual(codes(computeFlags(vseries('chatgpt', 3, 0), cfg)), []);                  // avg 3 < 4
  const f = computeFlags(vseries('organic', 20, 10), cfg)[0];
  assert.equal(f.text, 'ORGANIC_DOWN: google/organic sessions 10, prior 4-week avg 20, ratio 0.5 (flag <= 0.6, avg >= 10)');
  assert.equal(f.minAvg, 10);
});

test('CHATGPT_ZERO is the Vercel fallback: skipped while sources.ga4 is ok, evaluated otherwise', () => {
  const vercelZero = [0, 0, 0, 3, 1, 0, 0, 0];
  const weeks = STARTS.map((ws, i) => ({ ...vw(ws), referrers: { 'chatgpt.com': { visitors: vercelZero[i], pageviews: vercelZero[i] } } }));
  assert.deepEqual(codes(computeFlags(weeks, cfg, [], { ga4Ok: true })), []);                      // GA4 ok: CHATGPT_DOWN owns ChatGPT (steady here, so nothing)
  assert.deepEqual(codes(computeFlags(weeks, cfg, [], { ga4Ok: false })), ['CHATGPT_ZERO']);       // GA4 not configured / error
  assert.deepEqual(codes(computeFlags(weeks, cfg)), ['CHATGPT_ZERO']);                             // no google info at all
  const gptDrop = weeks.map((w, i) => ({ ...w, ga4: { ...w.ga4, bySource: { ...w.ga4.bySource, 'chatgpt.com/referral': { sessions: i === 7 ? 1 : 10, users: 1, keyEvents: 0 } } } }));
  assert.deepEqual(codes(computeFlags(gptDrop, cfg, [], { ga4Ok: true })), ['CHATGPT_DOWN']);     // the GA4 flag takes over
});

test('EVENT_DROP: one flag per watched event at or below 40% of a prior 4-week average of at least 3; generate_lead is history only', () => {
  // form_submit is not a lead event, so these isolate EVENT_DROP from LEADS_DOWN
  assert.deepEqual(codes(computeFlags(withEvents({ form_submit: 10 }, { form_submit: 4 }), cfg)), ['EVENT_DROP']);    // 0.4 exactly
  assert.deepEqual(codes(computeFlags(withEvents({ form_submit: 10 }, { form_submit: 5 }), cfg)), []);                // 0.5
  assert.deepEqual(codes(computeFlags(withEvents({ form_submit: 2 }, { form_submit: 0 }), cfg)), []);                 // avg 2 < 3: a trickle, not a drop
  assert.deepEqual(codes(computeFlags(withEvents({ form_submit: 3 }, { form_submit: 1 }), cfg)), ['EVENT_DROP']);     // avg 3 qualifies
  assert.deepEqual(codes(computeFlags(withEvents({ generate_lead: 10 }, { generate_lead: 0 }), cfg)), []);            // removed from eventDropEvents: table history only
  assert.deepEqual(codes(computeFlags(withEvents({ idea_submit: 5, form_step2_complete: 20 }, { idea_submit: 1 }), cfg)), ['EVENT_DROP']);   // idea form watched; leads 25 -> 21 hold
  const f = computeFlags(withEvents({ form_submit: 10 }, { form_submit: 4 }), cfg)[0];
  assert.equal(f.text, 'EVENT_DROP: form_submit events 4, prior 4-week avg 10, ratio 0.4 (flag <= 0.4, avg >= 3)');
  assert.deepEqual({ event: f.event, latest: f.latest, avg: f.avg, ratio: f.ratio, threshold: f.threshold, minAvg: f.minAvg, weekStart: f.weekStart }, { event: 'form_submit', latest: 4, avg: 10, ratio: 0.4, threshold: 0.4, minAvg: 3, weekStart: '2026-10-19' });
  const two = computeFlags(withEvents({ form_submit: 5, idea_submit: 5, form_step2_complete: 5 }, { form_submit: 1, idea_submit: 1 }), cfg);   // leads 10 -> 6: LEADS_DOWN too
  assert.deepEqual(two.map(f => [f.code, f.event]), [['LEADS_DOWN', undefined], ['EVENT_DROP', 'form_submit'], ['EVENT_DROP', 'idea_submit']]);
  assert.deepEqual(codes(computeFlags(withEvents({ form_submit: 10 }, { form_submit: 0 }).map(w => ({ ...w, ga4: null })), cfg)), []);   // no GA4
});

test('LEADS_DOWN at or below 60% of a prior 4-week lead average of at least 5; booking_confirmed EVENT_DROP is a flag only with it, otherwise an info line', () => {
  // leads only through form_step2_complete (not an EVENT_DROP event) isolate LEADS_DOWN
  assert.deepEqual(codes(computeFlags(withEvents({ form_step2_complete: 10 }, { form_step2_complete: 6 }), cfg)), ['LEADS_DOWN']);   // 0.6 exactly
  assert.deepEqual(codes(computeFlags(withEvents({ form_step2_complete: 10 }, { form_step2_complete: 7 }), cfg)), []);              // 0.7
  assert.deepEqual(codes(computeFlags(withEvents({ form_step2_complete: 4 }, { form_step2_complete: 0 }), cfg)), []);               // avg 4 < 5
  const f = computeFlags(withEvents({ form_step2_complete: 6, booking_confirmed: 4 }, { form_step2_complete: 3, booking_confirmed: 3 }), cfg)[0];   // leads 10 -> 6; booking 3/4 holds
  assert.equal(f.text, 'LEADS_DOWN: leads (form_step2_complete + booking_confirmed + idea_submit) 6, prior 4-week avg 10, ratio 0.6 (flag <= 0.6, avg >= 5)');
  assert.equal(f.weekStart, '2026-10-19');
  // booking collapses while total leads hold (bookings moved to the other forms): info line, not a flag
  const held = computeFlagsAndInfo(withEvents({ booking_confirmed: 5, idea_submit: 5 }, { booking_confirmed: 0, idea_submit: 9 }), cfg);   // leads 10 -> 9
  assert.deepEqual(codes(held.flags), []);
  assert.deepEqual(held.info.map(i => [i.code, i.event, i.info, i.reason]), [['EVENT_DROP', 'booking_confirmed', true, 'LEADS_DOWN did not fire']]);
  assert.equal(held.info[0].text, 'EVENT_DROP: booking_confirmed events 0, prior 4-week avg 5, ratio 0 (flag <= 0.4, avg >= 3) — info only: leads held, LEADS_DOWN did not fire');
  // booking collapses AND leads are down: both are flags, nothing demoted
  const both = computeFlagsAndInfo(withEvents({ booking_confirmed: 5, idea_submit: 5 }, { booking_confirmed: 0, idea_submit: 5 }), cfg);   // leads 10 -> 5
  assert.deepEqual(codes(both.flags), ['LEADS_DOWN', 'EVENT_DROP']);
  assert.equal(both.flags[1].event, 'booking_confirmed');
  assert.deepEqual(both.info, []);
  // the live numbers through Oct 19: booking 2 vs avg 5 (0.4) but leads 3+2+11 = 16 vs avg 9 -> info only; generate_lead 1 vs 5.8 no longer watched
  const live = STARTS.map((ws, i) => { const w = vw(ws); w.ga4.events = { form_submit: [6, 4, 3, 2, 3, 3, 4, 3][i], form_step2_complete: [6, 4, 3, 2, 3, 3, 4, 3][i], booking_confirmed: [2, 5, 1, 2, 10, 3, 5, 2][i], generate_lead: [3, 6, 7, 8, 5, 10, 0, 1][i], idea_submit: [0, 0, 0, 0, 0, 1, 3, 11][i] }; w.ga4.leads = leadsOf(w.ga4.events, cfg.ga4.leadEvents); return w; });
  const r = computeFlagsAndInfo(live, cfg);
  assert.deepEqual(codes(r.flags), []);
  assert.deepEqual(r.info.map(i => `${i.event} ${i.ratio}`), ['booking_confirmed 0.4']);
  assert.deepEqual(computeFlags(live, cfg), r.flags);   // computeFlags is the flags half of computeFlagsAndInfo
});

test('ga4Provisional: a week is provisional until 48 hours after it ended (Monday 00:00 UTC)', () => {
  assert.equal(ga4Provisional('2026-10-26', '2026-11-02T11:05:00Z', 48), true);     // the Monday 11:00 schedule, 11 h after the week ended
  assert.equal(ga4Provisional('2026-10-26', '2026-11-03T23:00:00Z', 48), true);     // Tuesday evening, 47 h
  assert.equal(ga4Provisional('2026-10-26', '2026-11-04T00:00:00Z', 48), false);    // exactly 48 h: final
  assert.equal(ga4Provisional('2026-10-19', '2026-11-02T11:05:00Z', 48), false);    // the week before is long final
  assert.equal(ga4Provisional('2026-10-26', null, 48), false);
  assert.equal(ga4Provisional('2026-10-26', '2026-11-04T00:00:00Z', 72), true);     // the lag is configurable
  const [a, b] = buildGa4Weeks(WEEKS2, { sources: normalizeGa4(GA4_SOURCES), events: null }, cfg, '2026-10-26T11:05:00Z');
  assert.equal(a.provisional, false); assert.equal(b.provisional, true);
  const [, c] = buildGa4Weeks(WEEKS2, { sources: normalizeGa4(GA4_SOURCES), events: null }, cfg, '2026-10-28T12:00:00Z');
  assert.equal(c.provisional, false);
  assert.deepEqual(buildGa4Weeks(WEEKS2, { sources: null, events: null }, cfg, '2026-10-26T11:05:00Z'), [null, null]);   // not configured: still null, not { provisional }
});

test('with a provisional newest week the GA4 flags move to the week before it and say so; Vercel flags stay on the newest', () => {
  // newest week (Oct 19): organic collapses to 0 and GA4 sessions are far from Vercel; the week before (Oct 12) is normal
  const fresh = STARTS.map((ws, i) => { const w = vw(ws, { organic: i === 7 ? 0 : 20, sessions: i === 7 ? 900 : 120 }); w.ga4.provisional = i === 7; return w; });
  assert.deepEqual(codes(computeFlags(fresh, cfg, [], { ga4Ok: true })), []);
  // the week before drops instead: flagged, labelled with that week, weekStart carried; Vercel's US_NOREF_DOWN still reads the newest week
  const prior = STARTS.map((ws, i) => { const w = vw(ws, { organic: i === 6 ? 0 : 20, chatgpt: i === 6 ? 0 : 5, sessions: i === 6 ? 900 : 120 }); w.ga4.events = { idea_submit: i === 6 ? 0 : 5 }; w.ga4.leads = leadsOf(w.ga4.events, cfg.ga4.leadEvents); w.ga4.provisional = i === 7; w.referrers = { '': { visitors: i === 7 ? 10 : 100, pageviews: 0 }, 'chatgpt.com': { visitors: 1, pageviews: 1 } }; return w; });
  const flags = computeFlags(prior, cfg, [], { ga4Ok: true });
  assert.deepEqual(codes(flags), ['US_NOREF_DOWN', 'ORGANIC_DOWN', 'CHATGPT_DOWN', 'LEADS_DOWN', 'EVENT_DROP', 'GA4_VS_VERCEL_GAP']);
  const org = flags.find(f => f.code === 'ORGANIC_DOWN');
  assert.equal(org.text, 'ORGANIC_DOWN (week of Oct 12): google/organic sessions 0, prior 4-week avg 20, ratio 0 (flag <= 0.6, avg >= 10)');
  assert.equal(org.weekStart, '2026-10-12');
  assert.equal(flags.find(f => f.code === 'LEADS_DOWN').text, 'LEADS_DOWN (week of Oct 12): leads (form_step2_complete + booking_confirmed + idea_submit) 0, prior 4-week avg 5, ratio 0 (flag <= 0.6, avg >= 5)');
  assert.equal(flags.find(f => f.code === 'EVENT_DROP').text, 'EVENT_DROP (week of Oct 12): idea_submit events 0, prior 4-week avg 5, ratio 0 (flag <= 0.4, avg >= 3)');
  const gap = flags.find(f => f.code === 'GA4_VS_VERCEL_GAP');
  assert.equal(gap.text, 'GA4_VS_VERCEL_GAP (week of Oct 12): GA4 US sessions 900 vs Vercel US visitors 100, gap 0.89 of the larger (flag > 0.5)');
  assert.equal(gap.weekStart, '2026-10-12');
  assert.equal(flags.find(f => f.code === 'US_NOREF_DOWN').text, 'US_NOREF_DOWN: US no-referrer visitors 10, prior 4-week avg 100, ratio 0.1 (flag <= 0.75)');
  // not provisional: same data, GA4 flags read the newest week and carry no suffix
  const final = prior.map(w => ({ ...w, ga4: { ...w.ga4, provisional: false } }));
  const f2 = computeFlags(final, cfg, [], { ga4Ok: true });
  assert.deepEqual(codes(f2), ['US_NOREF_DOWN']);                                   // Oct 12's dip is now inside the baseline, the newest week is normal
  const single = computeFlags(vseries('organic', 20, 5), cfg)[0];
  assert.equal(single.weekStart, '2026-10-19');                                       // weekStart is always present on GA4 flags
  assert.ok(!single.text.includes('week of'));
});

test('GA4_VS_VERCEL_GAP is symmetric and strict: more than half of the larger count', () => {
  assert.deepEqual(codes(computeFlags(vseries('sessions', 120, 240).map((w, i) => (i === 7 ? { ...w, us: { visitors: 116, pageviews: 0 } } : w)), cfg)), ['GA4_VS_VERCEL_GAP']);   // 0.52
  assert.deepEqual(codes(computeFlags(vseries('sessions', 120, 232).map((w, i) => (i === 7 ? { ...w, us: { visitors: 116, pageviews: 0 } } : w)), cfg)), []);                     // exactly 0.5
  assert.deepEqual(codes(computeFlags(vseries('sessions', 120, 100).map(w => ({ ...w, us: { visitors: 300, pageviews: 0 } })), cfg)), ['GA4_VS_VERCEL_GAP']);   // Vercel high every week (no TRAFFIC_UP): 0.67
  assert.deepEqual(codes(computeFlags(vseries('sessions', 120, 120).map(w => ({ ...w, ga4: null })), cfg)), []);                                                              // no GA4
  const f = computeFlags(vseries('sessions', 120, 240).map((w, i) => (i === 7 ? { ...w, us: { visitors: 116, pageviews: 0 } } : w)), cfg)[0];
  assert.equal(f.text, 'GA4_VS_VERCEL_GAP: GA4 US sessions 240 vs Vercel US visitors 116, gap 0.52 of the larger (flag > 0.5)');
});

test('DATA_GAP covers Google query and token failures; "not configured" is not a gap; order ends with DATA_GAP', () => {
  const g = computeFlags(vseries('us', 100, 100), cfg, [{ query: 'ga4:sources', message: 'HTTP 403 forbidden' }]);
  assert.deepEqual(codes(g), ['DATA_GAP']);
  assert.equal(g[0].text, 'DATA_GAP: query ga4:sources failed (HTTP 403 forbidden)');
  const t = computeFlags(vseries('us', 100, 100), cfg, [{ query: 'google:token', message: 'refresh token expired — rerun google-auth-once' }]);
  assert.equal(t[0].text, 'DATA_GAP: query google:token failed (refresh token expired — rerun google-auth-once)');
  assert.deepEqual(computeFlags(vseries('us', 100, 100).map(w => ({ ...w, ga4: null })), cfg, [], {}), []);
  const weeks = STARTS.map((ws, i) => { const w = vw(ws, { organic: i === 7 ? 1 : 20, chatgpt: i === 7 ? 0 : 5, sessions: i === 7 ? 400 : 120 }); w.ga4.events = { idea_submit: i === 7 ? 0 : 5 }; w.ga4.leads = leadsOf(w.ga4.events, cfg.ga4.leadEvents); return w; });
  const gsc = completeWeeks('2026-11-01T22:00:00Z', 16).weekStarts.map((ws, i) => gw(ws, { impressions: i === 15 ? 100 : 1000, brand: i === 15 ? 10 : 100 }));
  assert.deepEqual(codes(computeFlags(weeks, cfg, [{ query: 'gsc:brand', message: 'HTTP 500' }], { gscWeeks: gsc, ga4Ok: true })), ['BRAND_IMPR_DOWN', 'ORGANIC_DOWN', 'CHATGPT_DOWN', 'LEADS_DOWN', 'EVENT_DROP', 'GSC_IMPR_DOWN', 'GA4_VS_VERCEL_GAP', 'DATA_GAP']);
});

// ---------------------------------------------------------------- traffic.md
test('renderMarkdown: GA4 and Search Console sections, provisional mark, movers line, combined sources line; not configured otherwise', () => {
  const win = completeWeeks('2026-11-02T11:05:00Z', 8);
  const weeks = win.weekStarts.map(ws => vw(ws, { organic: 20, chatgpt: 5, sessions: 120 }));
  weeks[7].ga4.events = { form_submit: 3, form_step2_complete: 0, booking_confirmed: 0, generate_lead: 1, idea_submit: 2 };
  weeks[7].ga4.leads = leadsOf(weeks[7].ga4.events, cfg.ga4.leadEvents);   // 2
  const g16 = completeWeeks('2026-11-02T11:05:00Z', 16).weekStarts.map((ws, i) => ({ ...gw(ws), provisional: i === 15 }));
  const gsc = { siteUrl: 'sc-domain:rma-engineering.com', weeks: g16, provisionalWeekStart: '2026-10-26', topQueries: { latestWeekStart: '2026-10-26', priorWeekStart: '2026-10-19',
    rows: [{ query: 'rma engineering', impressions: 120, clicks: 30, prior: 100, priorClicks: 25, delta: 20 }], up: [{ query: 'rma engineering', delta: 20 }], down: [{ query: 'prototype cost', delta: -15 }] } };
  const report = { generatedAt: '2026-11-02T11:07:12.000Z', window: { weeks: 8, weekStarts: win.weekStarts }, sources: { vercel: { ok: true, queriesOk: 5, queriesTotal: 5, errors: [] }, ga4: 'ok', gsc: 'ok' }, flags: [], weeks, gsc };
  const md = renderMarkdown(report, cfg);
  assert.ok(md.includes('## GA4 sessions by source (US)\n| Week | Sessions | Ads | Organic | Direct | ChatGPT | Bing | LinkedIn | Other | Key ev |\n|---|---|---|---|---|---|---|---|---|---|\n| Sep 7 | 120 | 0 | 20 | 0 | 5 | 0 | 0 | 0 | 1 |\n'), md);
  assert.ok(md.includes('## GA4 events (US)\n| Week | form_submit | generate_lead | idea_submit | Leads |\n|---|---|---|---|---|\n'), md);   // only events with a non-zero week, plus Leads
  assert.ok(md.includes('| Oct 19 | 0 | 0 | 0 | 0 |\n| Oct 26 | 3 | 1 | 2 | 2 |\n'), md);
  assert.ok(!md.includes('GA4 reporting lags'), md);                                                                   // nothing provisional here
  assert.ok(!md.includes('Info:'), md);
  const provisional = renderMarkdown({ ...report, weeks: weeks.map((w, i) => ({ ...w, ga4: { ...w.ga4, provisional: i === 7 } })) }, cfg);
  assert.ok(provisional.includes('| Oct 26* | 120 | 0 | 20 | 0 | 5 | 0 | 0 | 0 | 1 |\n'), provisional);                // sessions table marked
  assert.ok(provisional.includes('| Oct 26* | 3 | 1 | 2 | 2 |\n\\* provisional: GA4 reporting lags up to 48 hours; GA4 flags use the week of Oct 19\n'), provisional);   // events table marked + footnote
  const infoLine = { code: 'EVENT_DROP', event: 'booking_confirmed', info: true, text: 'EVENT_DROP: booking_confirmed events 0, prior 4-week avg 5, ratio 0 (flag <= 0.4, avg >= 3) — info only: leads held, LEADS_DOWN did not fire' };
  const withInfo = renderMarkdown({ ...report, info: [infoLine] }, cfg);
  assert.ok(withInfo.startsWith('# Weekly traffic · generated 2026-11-02 11:07 UTC · 8 weeks Sep 7 to Nov 1 · 0 flags\n'), withInfo);   // info is not counted
  assert.ok(withInfo.includes('## Flags\nNo flags\nInfo: EVENT_DROP: booking_confirmed events 0, prior 4-week avg 5, ratio 0 (flag <= 0.4, avg >= 3) — info only: leads held, LEADS_DOWN did not fire\n\nSources:'), withInfo);
  assert.ok(provisional.includes('| Oct 19 | 120 |'), provisional);                                                    // only the newest week carries the mark
  assert.ok(md.includes('## Search Console (US)\n| Week | Clicks | Impr | Brand impr | Brand clicks | Pos |\n|---|---|---|---|---|---|\n| Sep 7 | 10 | 1000 | 100 | 5 | 8 |\n'), md);
  assert.ok(md.includes('| Oct 26* | 10 | 1000 | 100 | 5 | 8 |\n\\* provisional: Search Console data lags about 3 days\n'), md);
  assert.equal((md.match(/^\| (Sep|Oct) \d+\*? \| 10 \| 1000 /gm) || []).length, 8);                                      // last 8 of the 16 weeks
  assert.ok(md.includes('## Top 25 queries by impressions · Oct 26* vs Oct 19\n| Query | Impr | Prior | Clicks |\n|---|---|---|---|\n| rma engineering | 120 | 100 | 30 |\n'), md);
  assert.ok(md.includes('\nMovers: up rma engineering +20 · down prototype cost -15\n'), md);
  assert.ok(md.endsWith('\nSources: Vercel ok (5/5 queries) · GA4 ok · Search Console ok\n'), md);

  const none = renderMarkdown({ ...report, weeks: weeks.map(w => ({ ...w, ga4: null })), gsc: null, sources: { ...report.sources, ga4: 'not configured', gsc: 'not configured' } }, cfg);
  assert.ok(none.includes('## GA4 sessions by source (US)\nnot configured\n'), none);
  assert.ok(none.includes('## Search Console (US)\nnot configured\n'), none);
  assert.ok(none.endsWith('\nSources: Vercel ok (5/5 queries) · GA4 not configured · Search Console not configured\n'), none);

  const expired = renderMarkdown({ ...report, weeks: weeks.map(w => ({ ...w, ga4: null })), gsc: null, sources: { ...report.sources, ga4: 'error: refresh token expired — rerun google-auth-once', gsc: 'error: refresh token expired — rerun google-auth-once' } }, cfg);
  assert.ok(expired.includes('## GA4 sessions by source (US)\nerror: refresh token expired — rerun google-auth-once\n'), expired);
});
