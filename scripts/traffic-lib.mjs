// rma-site-snapshots — scripts/traffic-lib.mjs
// Pure helpers for the weekly traffic report: the complete-week window, the Vercel query definitions and URLs, bucketing
// of Vercel Web Analytics / GA4 / Search Console rows into per-week records, the flag rules and the traffic.md renderer.
// No network and no fs, so `npm test` (tests/traffic.test.mjs, tests/traffic-google.test.mjs) covers them without any
// token. scripts/traffic.mjs is the thin runner around these.
//
// Vercel rows look like { timestamp: "2026-10-19T00:00:00.000Z", visitors: 58, pageviews: 114, <dimension>: value } —
// one row per (week, dimension value), zero rows included; the dimension key is the `by` name (referrerHostname,
// requestPath, country); "" is "no referrer"; everything past `limit` is folded into one value "Others". Visitors are
// unique per row, so sums across rows (page groups, per-path lists) count a person once per page; pageviews add exactly.
// GA4 runReport rows are { dimensionValues: [{ value }], metricValues: [{ value }] } in header order, with `date` as
// YYYYMMDD. Search Console rows are { keys: [...], clicks, impressions, ctr, position } with dates as YYYY-MM-DD.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const OVERFLOW = 'Others';
export const isoDate = d => new Date(d).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const weekLabel = ws => { const d = new Date(ws + 'T00:00:00.000Z'); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const num = x => (typeof x === 'number' && Number.isFinite(x)) ? x : (Number(x) || 0);
const round = (x, p) => x == null ? null : Math.round(x * 10 ** p) / 10 ** p;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ---------------------------------------------------------------- week math (weeks start Monday 00:00 UTC)
export function mondayOf(d) {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t;
}
export const weekEndOf = ws => isoDate(new Date(ws + 'T00:00:00.000Z').getTime() + 6 * 86400000);
export const weekOfDate = iso => isoDate(mondayOf(new Date(iso + 'T00:00:00.000Z')));   // 'YYYY-MM-DD' -> its Monday

// The n most recent COMPLETE Monday–Sunday weeks as of `now`; the week containing `now` is never one of them.
// `until` is the last millisecond of the newest complete week: Vercel treats `until` as inclusive and widens it to the
// granularity, so a Monday-00:00 `until` would pull in the partial current week as a ninth row.
export function completeWeeks(now, n) {
  const current = mondayOf(now);
  const weekStarts = Array.from({ length: n }, (_, i) => isoDate(current.getTime() - (n - i) * WEEK_MS));
  return { since: new Date(current.getTime() - n * WEEK_MS), until: new Date(current.getTime() - 1), weekStarts };
}

// ---------------------------------------------------------------- Vercel queries
// Five calls per run. Everything is filtered to cfg.country except the no-referrer-by-country query, which needs every
// country to compute the non-US share. utmSource / utmMedium are never requested (402 on the current plan).
export function queryDefs(cfg) {
  const US = `country eq '${cfg.country || 'US'}'`;
  return {
    us:             { by: ['week'],                     filter: US },
    referrers:      { by: ['week', 'referrerHostname'], filter: US, limit: cfg.referrers?.limit ?? 20 },
    paths:          { by: ['week', 'requestPath'],      filter: US, limit: cfg.paths?.limit ?? 60 },
    countriesNoRef: { by: ['week', 'country'],          filter: "referrerHostname eq ''", limit: cfg.countries?.limit ?? 10 },
    chatgptPages:   { by: ['week', 'requestPath'],      filter: `${US} and referrerHostname eq '${cfg.chatgptPages?.referrer ?? 'chatgpt.com'}'`, limit: cfg.chatgptPages?.limit ?? 20 },
  };
}
// `by` is repeated (by=week&by=requestPath); spaces are %20, not "+", so the OData filter survives any decoder
export function buildQueryUrl(v, q, { since, until }) {
  const params = [['teamId', v.teamId], ['projectId', v.projectId], ['since', new Date(since).toISOString()], ['until', new Date(until).toISOString()], ...q.by.map(b => ['by', b])];
  if (q.filter) params.push(['filter', q.filter]);
  if (q.limit) params.push(['limit', String(q.limit)]);
  return `${v.endpoint || 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate'}?${params.map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`).join('&')}`;
}

// ---------------------------------------------------------------- Vercel normalization + bucketing
export const normalizeHost = h => String(h ?? '').trim().toLowerCase().replace(/^www\./, '');
export function normalizePath(p) {
  let s = String(p ?? '').trim().split(/[?#]/)[0];
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}
// Map weekStart -> rows of that week (rows outside the window are dropped; every window week has an entry)
export function rowsByWeek(rows, weekStarts) {
  const m = new Map(weekStarts.map(ws => [ws, []]));
  for (const r of rows || []) {
    const ts = r.timestamp ?? r.week ?? r.date;
    if (ts == null) continue;
    const ws = isoDate(mondayOf(new Date(ts)));
    if (m.has(ws)) m.get(ws).push(r);
  }
  return m;
}
const zero = () => ({ visitors: 0, pageviews: 0 });
const add = (acc, r) => { acc.visitors += num(r.visitors); acc.pageviews += num(r.pageviews); return acc; };
export const compileGroups = groups => Object.fromEntries(Object.entries(groups || {}).map(([k, pats]) => [k, pats.map(p => new RegExp(p))]));
export const groupsOf = (path, compiled) => Object.entries(compiled).filter(([, res]) => res.some(re => re.test(path))).map(([k]) => k);

// results: { us, referrers, paths, countriesNoRef, chatgptPages } — each the rows of that query, or null when it failed.
// Returns one record per window week (oldest first); a failed query leaves its fields null in every week.
export function buildWeeks(weekStarts, results, cfg) {
  const keep = (cfg.referrers?.keep || []).map(normalizeHost);
  const compiled = compileGroups(cfg.pageGroups);
  const country = String(cfg.country || 'US').toUpperCase();
  const byWeek = Object.fromEntries(Object.entries(results).map(([k, rows]) => [k, rows ? rowsByWeek(rows, weekStarts) : null]));

  return weekStarts.map(ws => {
    const w = { weekStart: ws, weekEnd: weekEndOf(ws), us: null, referrers: null, groups: null, pages: null, pathOverflow: null, noReferrer: null, botShareNoReferrer: null, chatgptPages: null };
    if (byWeek.us) w.us = byWeek.us.get(ws).reduce(add, zero());
    if (byWeek.referrers) {
      const ref = Object.fromEntries([...keep, 'other'].map(k => [k, zero()]));
      for (const r of byWeek.referrers.get(ws)) { const h = normalizeHost(r.referrerHostname); add(keep.includes(h) ? ref[h] : ref.other, r); }
      w.referrers = ref;
    }
    if (byWeek.paths) {
      const pages = {}, overflow = zero();
      for (const r of byWeek.paths.get(ws)) {
        if (r.requestPath === OVERFLOW) { add(overflow, r); continue; }
        const p = normalizePath(r.requestPath);
        add(pages[p] ??= zero(), r);
      }
      const groups = Object.fromEntries(Object.keys(compiled).map(k => [k, zero()]));
      for (const [p, v] of Object.entries(pages)) for (const g of groupsOf(p, compiled)) add(groups[g], v);
      w.pages = pages; w.groups = groups; w.pathOverflow = overflow;
    }
    if (byWeek.countriesNoRef) {
      const total = zero(), us = zero();
      for (const r of byWeek.countriesNoRef.get(ws)) { add(total, r); if (String(r.country ?? '').toUpperCase() === country) add(us, r); }
      w.noReferrer = { total: total.visitors, us: us.visitors, nonUs: total.visitors - us.visitors };
      w.botShareNoReferrer = total.visitors ? round(w.noReferrer.nonUs / total.visitors, 3) : null;
    }
    if (byWeek.chatgptPages) {
      const m = {};
      for (const r of byWeek.chatgptPages.get(ws)) { const p = r.requestPath === OVERFLOW ? OVERFLOW : normalizePath(r.requestPath); add(m[p] ??= zero(), r); }
      w.chatgptPages = Object.entries(m).filter(([, v]) => v.visitors > 0 || v.pageviews > 0).map(([path, v]) => ({ path, ...v }))
        .sort((a, b) => b.visitors - a.visitors || a.path.localeCompare(b.path));
    }
    return w;
  });
}

// ---------------------------------------------------------------- GA4 (Data API v1beta runReport)
export const ga4Date = s => { const d = String(s ?? ''); return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d; };
// runReport response -> plain rows { <dimension>: string, <metric>: number } using the header order of the response
export function normalizeGa4(report) {
  const dims = (report?.dimensionHeaders || []).map(h => h.name);
  const mets = (report?.metricHeaders || []).map(h => h.name);
  return (report?.rows || []).map(r => {
    const o = {};
    dims.forEach((n, i) => { o[n] = r.dimensionValues?.[i]?.value ?? ''; });
    mets.forEach((n, i) => { o[n] = num(r.metricValues?.[i]?.value); });
    return o;
  });
}
// "source/medium" kept verbatim when listed; otherwise any source containing a cfg.ga4.sourceContains needle gets that
// bucket (linkedin -> "linkedin"; chatgpt -> "chatgpt.com/referral", because GA4 labels ChatGPT sessions
// "chatgpt.com / ai-assistant" — ChatGPT appends utm_source=chatgpt.com to its links — never "referral"); everything
// else is "other"
export function ga4Bucket(source, medium, cfg) {
  const key = `${source ?? ''}/${medium ?? ''}`;
  if ((cfg.ga4?.keep || []).includes(key)) return key;
  const s = String(source ?? '').toLowerCase();
  for (const [bucket, needle] of Object.entries(cfg.ga4?.sourceContains || {})) if (needle && s.includes(String(needle).toLowerCase())) return bucket;
  return 'other';
}
export const ga4Buckets = cfg => [...new Set([...(cfg.ga4?.keep || []), ...Object.keys(cfg.ga4?.sourceContains || {}), 'other'])];
// GA4 standard reporting lags up to ~48 hours: a week whose end (the Monday 00:00 UTC after it) is less than `lagHours`
// before `now` is still filling in. It is marked provisional in the tables and the GA4 flags are evaluated on the week
// before it. The Monday 11:00 UTC schedule always lands here; a run on Wednesday or later does not.
export function ga4Provisional(weekStart, now, lagHours = 48) {
  if (now == null) return false;
  const weekEndMs = new Date(weekStart + 'T00:00:00.000Z').getTime() + WEEK_MS;
  return new Date(now).getTime() - weekEndMs < lagHours * 3600000;
}
// sources: normalized rows of report 1 (date, sessionSource, sessionMedium, sessions, totalUsers, keyEvents) or null;
// events: normalized rows of report 2 (date, eventName, eventCount) or null. One record per window week, or null for a
// week when neither report ran. `users` is the sum of daily totalUsers, so a returning visitor counts once per day.
// `now` (optional) sets each week's `provisional` flag; without it no week is provisional.
// Leads = the sum of the cfg.ga4.leadEvents counts (form_step2_complete + booking_confirmed + idea_submit); null when
// the events report did not run
export const leadsOf = (events, leadEvents = []) => events ? leadEvents.reduce((n, e) => n + num(events[e]), 0) : null;
export function buildGa4Weeks(weekStarts, { sources, events }, cfg, now = null) {
  if (!sources && !events) return weekStarts.map(() => null);
  const lagHours = cfg.ga4?.provisionalLagHours ?? 48;
  const leadEvents = cfg.ga4?.leadEvents || [];
  const buckets = ga4Buckets(cfg);
  const names = cfg.ga4?.events || [];
  const blank = () => ({ sessions: 0, users: 0, keyEvents: 0 });
  const topN = cfg.ga4?.topSources ?? 10;
  const acc = Object.fromEntries(weekStarts.map(ws => [ws, {
    sessions: sources ? 0 : null, users: sources ? 0 : null, keyEvents: sources ? 0 : null,
    bySource: sources ? Object.fromEntries(buckets.map(b => [b, blank()])) : null,
    topSources: sources ? new Map() : null,   // raw "source/medium" -> sessions, for the diagnostic list below
    events: events ? Object.fromEntries(names.map(n => [n, 0])) : null,
  }]));
  for (const r of sources || []) {
    const ws = weekOfDate(ga4Date(r.date)); const w = acc[ws]; if (!w) continue;
    const b = w.bySource[ga4Bucket(r.sessionSource, r.sessionMedium, cfg)];
    for (const [k, m] of [['sessions', 'sessions'], ['users', 'totalUsers'], ['keyEvents', 'keyEvents']]) { w[k] += num(r[m]); b[k] += num(r[m]); }
    const raw = `${r.sessionSource ?? ''}/${r.sessionMedium ?? ''}`;
    w.topSources.set(raw, (w.topSources.get(raw) || 0) + num(r.sessions));
  }
  // topSources: the week's raw source/medium pairs by sessions (top N), so a new or oddly labelled referrer can be seen
  // in traffic.json without another query. Not rendered in traffic.md.
  for (const w of Object.values(acc)) if (w.topSources) w.topSources = [...w.topSources].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([sourceMedium, sessions]) => ({ sourceMedium, sessions }));
  for (const r of events || []) {
    const ws = weekOfDate(ga4Date(r.date)); const w = acc[ws]; if (!w) continue;
    const n = String(r.eventName ?? '');
    if (!(n in w.events)) { if (!names.length) w.events[n] = 0; else continue; }
    w.events[n] += num(r.eventCount);
  }
  return weekStarts.map(ws => ({ ...acc[ws], leads: leadsOf(acc[ws].events, leadEvents), provisional: ga4Provisional(ws, now, lagHours) }));
}

// ---------------------------------------------------------------- Google request bodies
// GA4 report 1: sessions / users / key events by day, source and medium, US only. Report 2: event counts by day for the
// configured event names, US only. Both cover the Vercel window (the same 8 complete weeks). `limit` is an int64 string.
const ga4Country = cfg => ({ filter: { fieldName: 'countryId', stringFilter: { matchType: 'EXACT', value: cfg.ga4?.country || cfg.country || 'US' } } });
const ga4Range = win => [{ startDate: isoDate(win.since), endDate: isoDate(win.until) }];
export function ga4SourcesRequest(win, cfg) {
  return { dateRanges: ga4Range(win), dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }], dimensionFilter: ga4Country(cfg),
    limit: String(cfg.ga4?.limit ?? 100000), keepEmptyRows: false };
}
export function ga4EventsRequest(win, cfg) {
  return { dateRanges: ga4Range(win), dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }],
    dimensionFilter: { andGroup: { expressions: [ga4Country(cfg), { filter: { fieldName: 'eventName', inListFilter: { values: cfg.ga4?.events || [] } } }] } },
    limit: String(cfg.ga4?.limit ?? 100000), keepEmptyRows: false };
}
// Search Console: by date over the 16-week window (optionally brand-filtered with cfg.gsc.brandRegex, RE2 syntax), or by
// query over one week. The country filter takes the 3-letter code (usa). dataState "all" includes the fresh last days,
// which is why the newest week is marked provisional.
export function gscRequest({ start, end }, { dimensions = ['date'], brand = false, rowLimit } = {}, cfg) {
  const filters = [{ dimension: 'country', operator: 'equals', expression: cfg.gsc?.country || 'usa' }];
  if (brand) filters.push({ dimension: 'query', operator: 'includingRegex', expression: cfg.gsc?.brandRegex || '(?i)rma eng|rma-eng' });
  return { startDate: start, endDate: end, dimensions, dimensionFilterGroups: [{ filters }], rowLimit: rowLimit ?? 1000, dataState: cfg.gsc?.dataState || 'all' };
}

// ---------------------------------------------------------------- Search Console
export const gscRows = res => Array.isArray(res) ? res : (res?.rows || []);
// The newest complete week is "provisional" while Search Console can still revise it: its last day plus
// cfg.gsc.provisionalLagDays is not yet behind `now` (the Monday run always marks it; a Thursday run does not).
export function isProvisional(weekStart, now, lagDays = 3) {
  const t = new Date(now);
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return new Date(weekEndOf(weekStart) + 'T00:00:00.000Z').getTime() + lagDays * 86400000 >= today;
}
// daily: rows of the by-date query (keys[0] = YYYY-MM-DD) or null; brandDaily: same shape for the brand-filtered query or
// null. Weekly position is the impression-weighted mean of the daily average positions (null without impressions).
export function buildGscWeeks(weekStarts, { daily, brandDaily }, cfg, now) {
  const lag = cfg.gsc?.provisionalLagDays ?? 3;
  const acc = Object.fromEntries(weekStarts.map(ws => [ws, { clicks: 0, impressions: 0, posW: 0, brand: brandDaily ? { clicks: 0, impressions: 0 } : null }]));
  for (const r of gscRows(daily)) {
    const w = acc[weekOfDate(String(r.keys?.[0] ?? ''))]; if (!w) continue;
    w.clicks += num(r.clicks); w.impressions += num(r.impressions); w.posW += num(r.position) * num(r.impressions);
  }
  if (brandDaily) for (const r of gscRows(brandDaily)) {
    const w = acc[weekOfDate(String(r.keys?.[0] ?? ''))]; if (!w) continue;
    w.brand.clicks += num(r.clicks); w.brand.impressions += num(r.impressions);
  }
  return weekStarts.map(ws => {
    const a = acc[ws];
    const base = daily ? { clicks: a.clicks, impressions: a.impressions, ctr: a.impressions ? round(a.clicks / a.impressions, 4) : null, position: a.impressions ? round(a.posW / a.impressions, 1) : null } : { clicks: null, impressions: null, ctr: null, position: null };
    return { weekStart: ws, weekEnd: weekEndOf(ws), ...base, brand: a.brand, provisional: isProvisional(ws, now, lag) };
  });
}
// latest / prior: rows of the by-query queries for the two weeks (keys[0] = query). Top N of the latest week by
// impressions, each with the prior week's numbers; movers = biggest impression gains / losses over the union of both
// weeks' top N.
export function topQueryMovers(latest, prior, cfg) {
  const n = cfg.gsc?.topQueries ?? 25, m = cfg.gsc?.movers ?? 5;
  const toMap = rows => { const o = new Map(); for (const r of gscRows(rows)) { const q = String(r.keys?.[0] ?? ''); const cur = o.get(q) || { impressions: 0, clicks: 0 }; cur.impressions += num(r.impressions); cur.clicks += num(r.clicks); o.set(q, cur); } return o; };
  const L = toMap(latest), P = toMap(prior);
  const topOf = map => [...map].sort((a, b) => b[1].impressions - a[1].impressions || a[0].localeCompare(b[0])).slice(0, n).map(([q]) => q);
  const row = q => { const l = L.get(q) || { impressions: 0, clicks: 0 }, p = P.get(q) || { impressions: 0, clicks: 0 }; return { query: q, impressions: l.impressions, clicks: l.clicks, prior: p.impressions, priorClicks: p.clicks, delta: l.impressions - p.impressions }; };
  const rows = topOf(L).map(row);
  const union = [...new Set([...topOf(L), ...topOf(P)])].map(row);
  const up = union.filter(r => r.delta > 0).sort((a, b) => b.delta - a.delta || a.query.localeCompare(b.query)).slice(0, m);
  const down = union.filter(r => r.delta < 0).sort((a, b) => a.delta - b.delta || a.query.localeCompare(b.query)).slice(0, m);
  return { rows, up, down };
}

// ---------------------------------------------------------------- flags
// Newest complete week vs the mean of the `baselineWeeks` weeks before it. Every threshold comes from cfg.thresholds.
// A ratio flag needs a baseline mean > 0 (a comparison against nothing says nothing) and a present latest value; some
// also need the mean to reach a minimum (ORGANIC_DOWN, CHATGPT_DOWN), so a trickle cannot look like a collapse.
const get = {
  usVisitors:        w => w.us?.visitors ?? null,
  usNoRefVisitors:   w => w.referrers?.['']?.visitors ?? null,
  deepPagesVisitors: w => w.groups?.deepPages?.visitors ?? null,
  adPagesVisitors:   w => w.groups?.adPages?.visitors ?? null,
  chatgptVisitors:   w => w.referrers?.['chatgpt.com']?.visitors ?? null,
  ga4Organic:        w => w.ga4?.bySource?.['google/organic']?.sessions ?? null,
  ga4Chatgpt:        w => w.ga4?.bySource?.['chatgpt.com/referral']?.sessions ?? null,
  ga4Sessions:       w => w.ga4?.sessions ?? null,
  ga4Leads:          w => w.ga4?.leads ?? null,
  gscImpressions:    w => w.impressions ?? null,
  gscBrandImpr:      w => w.brand?.impressions ?? null,
};

// errors: [{ query, message }] from any source (Vercel, GA4, Search Console, the Google token swap) — each one is a data
// gap. google: { gscWeeks, ga4Ok } — the 16-week Search Console series (null when not configured) and whether
// sources.ga4 is "ok" (decides which ChatGPT flag applies). weeks[i].ga4 carries GA4.
// Returns { flags, info }: info holds would-be flags demoted to an information line (a booking_confirmed EVENT_DROP
// while LEADS_DOWN did not fire); they are printed under the flags but never counted as one.
export const computeFlags = (weeks, cfg, errors = [], google = {}) => computeFlagsAndInfo(weeks, cfg, errors, google).flags;
export function computeFlagsAndInfo(weeks, cfg, errors = [], google = {}) {
  const T = cfg.thresholds || {};
  const nBase = cfg.window?.baselineWeeks ?? 4;
  const flags = [], info = [];
  // extra fields are copied onto the flag; extra.textSuffix (e.g. " (week of Oct 19)") goes after the code in the text
  const ratioFlag = (arr, code, label, getter, threshold, dir, minAvg = 0, extra = {}) => {
    const latest = arr[arr.length - 1];
    if (!latest) return;
    const { textSuffix = '', ...fields } = extra;
    const base = arr.slice(Math.max(0, arr.length - 1 - nBase), arr.length - 1);
    const cur = getter(latest);
    const xs = base.map(getter).filter(x => typeof x === 'number');
    const avg = mean(xs);
    if (cur == null || avg == null || avg <= 0 || avg < minAvg || typeof threshold !== 'number') return;
    const ratio = cur / avg;
    if (dir === 'down' ? ratio <= threshold : ratio >= threshold) {
      flags.push({ code, ...fields, latest: cur, avg: round(avg, 1), ratio: round(ratio, 2), threshold, ...(minAvg ? { minAvg } : {}), baselineWeeks: xs.length,
        text: `${code}${textSuffix}: ${label} ${cur}, prior ${xs.length}-week avg ${round(avg, 1)}, ratio ${round(ratio, 2)} (flag ${dir === 'down' ? '<=' : '>='} ${threshold}${minAvg ? `, avg >= ${minAvg}` : ''})` });
    }
  };
  const latest = weeks[weeks.length - 1];
  const base = weeks.slice(Math.max(0, weeks.length - 1 - nBase), weeks.length - 1);
  if (latest) {
    ratioFlag(weeks, 'US_NOREF_DOWN', 'US no-referrer visitors', get.usNoRefVisitors, T.usNoRefDownRatio, 'down');
    ratioFlag(weeks, 'DEEP_PAGES_DOWN', 'deep-page visitors', get.deepPagesVisitors, T.deepPagesDownRatio, 'down');
    // CHATGPT_ZERO is the Vercel-side ChatGPT check (referrer chatgpt.com). It runs only while GA4 is not available:
    // with sources.ga4 = ok, CHATGPT_DOWN on GA4's chatgpt.com/ai-assistant sessions is the ChatGPT flag, because
    // Vercel misses the app clicks that arrive with utm_source=chatgpt.com but no referrer and reads 0 while GA4 is steady.
    if (!google.ga4Ok) {
      const zeroWeeks = T.chatgptZeroWeeks ?? 2, maxAtLeast = T.chatgptMaxAtLeast ?? 3;
      const gpt = weeks.map(get.chatgptVisitors);
      if (gpt.length >= zeroWeeks && gpt.every(x => typeof x === 'number')) {
        const tail = gpt.slice(-zeroWeeks), max = Math.max(...gpt);
        if (tail.every(x => x === 0) && max >= maxAtLeast) {
          flags.push({ code: 'CHATGPT_ZERO', latest: tail, max, threshold: maxAtLeast, zeroWeeks,
            text: `CHATGPT_ZERO: chatgpt.com visitors ${tail.join(', ')} in the last ${zeroWeeks} weeks; ${weeks.length}-week max ${max} (flag >= ${maxAtLeast})` });
        }
      }
    }
    ratioFlag(weeks, 'AD_PAGES_DOWN', 'ad-page visitors', get.adPagesVisitors, T.adPagesDownRatio, 'down');
    ratioFlag(weeks, 'TRAFFIC_UP', 'US visitors', get.usVisitors, T.trafficUpRatio, 'up');
    // BOT_SPIKE: the newest week's non-US share of no-referrer visitors is at or above `botShareSpikeRatio` x the prior
    // baseline average, OR at or above `botShareSpikeAbsolute` outright. The normal share here sits at 0.45–0.57 every
    // week (Singapore/China one-pageview sessions), so a fixed line at 0.5 fired constantly; a jump is the signal.
    const share = latest.botShareNoReferrer;
    if (typeof share === 'number') {
      const xs = base.map(w => w.botShareNoReferrer).filter(x => typeof x === 'number');
      const avg = mean(xs);
      const ratio = avg != null && avg > 0 ? share / avg : null;
      const byRatio = typeof T.botShareSpikeRatio === 'number' && ratio != null && ratio >= T.botShareSpikeRatio;
      const byAbsolute = typeof T.botShareSpikeAbsolute === 'number' && share >= T.botShareSpikeAbsolute;
      if (byRatio || byAbsolute) {
        flags.push({ code: 'BOT_SPIKE', latest: share, avg: round(avg, 3), ratio: round(ratio, 2), ratioThreshold: T.botShareSpikeRatio ?? null, absoluteThreshold: T.botShareSpikeAbsolute ?? null,
          baselineWeeks: xs.length, nonUs: latest.noReferrer.nonUs, total: latest.noReferrer.total,
          text: `BOT_SPIKE: non-US share of no-referrer visitors ${share} (${latest.noReferrer.nonUs}/${latest.noReferrer.total}), prior ${xs.length}-week avg ${avg == null ? 'n/a' : round(avg, 3)}, ratio ${ratio == null ? 'n/a' : round(ratio, 2)} (flag >= ${T.botShareSpikeRatio}x avg or >= ${T.botShareSpikeAbsolute})` });
      }
    }
    // Search Console
    const gscWeeks = google.gscWeeks || [];
    ratioFlag(gscWeeks, 'BRAND_IMPR_DOWN', 'brand impressions', get.gscBrandImpr, T.brandImprDownRatio, 'down');
    // GA4 flags. When the newest week's GA4 data is still filling in (ga4.provisional: the run started less than
    // ga4.provisionalLagHours after the week ended), they are evaluated on the week before it and say so in the text.
    const gaWeeks = latest.ga4?.provisional && weeks.length > 1 ? weeks.slice(0, -1) : weeks;
    const gaLatest = gaWeeks[gaWeeks.length - 1];
    const gaExtra = { weekStart: gaLatest.weekStart, ...(gaWeeks === weeks ? {} : { textSuffix: ` (week of ${weekLabel(gaLatest.weekStart)})` }) };
    ratioFlag(gaWeeks, 'ORGANIC_DOWN', 'google/organic sessions', get.ga4Organic, T.organicDownRatio, 'down', T.organicDownMinAvg ?? 0, gaExtra);
    ratioFlag(gaWeeks, 'CHATGPT_DOWN', 'chatgpt.com/referral sessions', get.ga4Chatgpt, T.chatgptDownRatio, 'down', T.chatgptDownMinAvg ?? 0, gaExtra);
    // LEADS_DOWN: the lead total (cfg.ga4.leadEvents summed) at or below `leadsDownRatio` of a prior 4-week average of
    // at least `leadsDownMinAvg`
    ratioFlag(gaWeeks, 'LEADS_DOWN', `leads (${(cfg.ga4?.leadEvents || []).join(' + ')})`, get.ga4Leads, T.leadsDownRatio, 'down', T.leadsDownMinAvg ?? 0, gaExtra);
    // EVENT_DROP: one flag per configured GA4 event whose evaluated week is at or below `eventDropRatio` of a prior
    // 4-week average of at least `eventDropMinAvg` (a trickle of 1–2 events a week cannot "drop")
    for (const name of T.eventDropEvents || []) {
      ratioFlag(gaWeeks, 'EVENT_DROP', `${name} events`, w => w.ga4?.events?.[name] ?? null, T.eventDropRatio, 'down', T.eventDropMinAvg ?? 0, { event: name, ...gaExtra });
    }
    // Events in `eventDropRequiresLeadsDown` (booking_confirmed) only count as a flag when LEADS_DOWN fired too: a lone
    // booking dip while total leads hold is bookings moving to the other forms, so it becomes an info line instead.
    const gated = new Set(T.eventDropRequiresLeadsDown || []);
    if (gated.size && !flags.some(f => f.code === 'LEADS_DOWN')) {
      for (let i = flags.length - 1; i >= 0; i--) {
        const f = flags[i];
        if (f.code === 'EVENT_DROP' && gated.has(f.event)) {
          flags.splice(i, 1);
          info.unshift({ ...f, info: true, reason: 'LEADS_DOWN did not fire', text: `${f.text} — info only: leads held, LEADS_DOWN did not fire` });
        }
      }
    }
    ratioFlag(gscWeeks, 'GSC_IMPR_DOWN', 'Search Console impressions', get.gscImpressions, T.gscImprDownRatio, 'down');
    // GA4_VS_VERCEL_GAP: the two US counts for the evaluated week disagree by more than `ga4VsVercelGapShare` of the
    // larger one (symmetric, so it does not matter which side is high). Sessions and visitors are different units, which
    // is why the line sits at 50% and not lower.
    const a = get.ga4Sessions(gaLatest), b = get.usVisitors(gaLatest);
    if (typeof a === 'number' && typeof b === 'number' && Math.max(a, b) > 0 && typeof T.ga4VsVercelGapShare === 'number') {
      const gap = round(Math.abs(a - b) / Math.max(a, b), 2);
      if (gap > T.ga4VsVercelGapShare) flags.push({ code: 'GA4_VS_VERCEL_GAP', weekStart: gaLatest.weekStart, ga4Sessions: a, vercelVisitors: b, gap, threshold: T.ga4VsVercelGapShare,
        text: `GA4_VS_VERCEL_GAP${gaExtra.textSuffix || ''}: GA4 US sessions ${a} vs Vercel US visitors ${b}, gap ${gap} of the larger (flag > ${T.ga4VsVercelGapShare})` });
    }
  }
  const zeroUs = weeks.filter(w => w.us && w.us.visitors === 0).map(w => w.weekStart);
  if (errors.length || zeroUs.length) {
    const parts = errors.map(e => `query ${e.query} failed (${e.message})`);
    if (zeroUs.length) parts.push(`0 US visitors in week${zeroUs.length > 1 ? 's' : ''} ${zeroUs.join(', ')}`);
    flags.push({ code: 'DATA_GAP', failedQueries: errors.map(e => e.query), zeroUsWeeks: zeroUs, text: `DATA_GAP: ${parts.join('; ')}` });
  }
  return { flags, info };
}

// ---------------------------------------------------------------- traffic.md
// Phone-sized: one header line, the 8-week Vercel table, deep pages by page, GA4 sessions by source (+ events), Search
// Console weekly + top queries, flags, sources. Numbers only.
export function renderMarkdown(report, cfg) {
  const { generatedAt, window, weeks, flags, sources, gsc } = report;
  const cols = cfg.report?.pageColumns || ['/contact-us', '/inventors'];
  const cell = v => v == null ? '-' : String(v);
  const pct = v => v == null ? '-' : `${Math.round(v * 100)}%`;
  const pageCell = (w, p) => cell(w.pages ? (w.pages[p]?.visitors ?? 0) : null);
  const sep = n => `|${'---|'.repeat(n)}`;
  const gen = String(generatedAt).replace('T', ' ').slice(0, 16) + ' UTC';
  const first = window.weekStarts[0], last = window.weekStarts[window.weekStarts.length - 1];
  const L = [];
  L.push(`# Weekly traffic · generated ${gen} · ${window.weeks} weeks ${weekLabel(first)} to ${weekLabel(weekEndOf(last))} · ${flags.length} flag${flags.length === 1 ? '' : 's'}`);

  // Vercel
  L.push('', `## Vercel (US)`, `| Week | US vis | NoRef vis | NoRef pv | Google | ChatGPT | Deep | ${cols.join(' | ')} | Bot |`, sep(8 + cols.length));
  for (const w of weeks) {
    L.push(`| ${weekLabel(w.weekStart)} | ${cell(w.us?.visitors)} | ${cell(w.referrers?.['']?.visitors)} | ${cell(w.referrers?.['']?.pageviews)} | ${cell(w.referrers?.['google.com']?.visitors)} | ${cell(w.referrers?.['chatgpt.com']?.visitors)} | ${cell(w.groups?.deepPages?.visitors)} | ${cols.map(c => pageCell(w, c)).join(' | ')} | ${pct(w.botShareNoReferrer)} |`);
  }
  const n = Math.min(cfg.report?.deepPagesWeeks ?? 4, weeks.length);
  const recent = weeks.slice(weeks.length - n);
  const deepRe = compileGroups(cfg.pageGroups).deepPages || [];
  const totals = new Map();
  for (const w of recent) for (const [p, v] of Object.entries(w.pages || {})) if (deepRe.some(re => re.test(p))) totals.set(p, (totals.get(p) || 0) + v.visitors);
  L.push('', `## Deep pages, last ${n} weeks (US visitors)`);
  if (!totals.size) L.push('none');
  else {
    L.push(`| Page | ${recent.map(w => weekLabel(w.weekStart)).join(' | ')} |`, sep(1 + recent.length));
    for (const [p] of [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) L.push(`| ${p} | ${recent.map(w => pageCell(w, p)).join(' | ')} |`);
  }

  // GA4
  const ga4Status = sources?.ga4 ?? 'not configured';
  L.push('', '## GA4 sessions by source (US)');
  if (!weeks.some(w => w.ga4)) L.push(ga4Status);
  else {
    const gcols = cfg.report?.ga4Columns || ga4Buckets(cfg).map(k => ({ label: k, key: k }));
    const gmark = w => `${weekLabel(w.weekStart)}${w.ga4?.provisional ? '*' : ''}`;
    L.push(`| Week | Sessions | ${gcols.map(c => c.label).join(' | ')} | Key ev |`, sep(3 + gcols.length));
    for (const w of weeks) L.push(`| ${gmark(w)} | ${cell(w.ga4?.sessions)} | ${gcols.map(c => cell(w.ga4?.bySource ? (w.ga4.bySource[c.key]?.sessions ?? 0) : null)).join(' | ')} | ${cell(w.ga4?.keyEvents)} |`);
    const names = (cfg.ga4?.events || []).filter(e => weeks.some(w => (w.ga4?.events?.[e] ?? 0) > 0));
    if (names.length) {
      L.push('', '## GA4 events (US)', `| Week | ${names.join(' | ')} | Leads |`, sep(2 + names.length));
      for (const w of weeks) L.push(`| ${gmark(w)} | ${names.map(e => cell(w.ga4?.events ? (w.ga4.events[e] ?? 0) : null)).join(' | ')} | ${cell(w.ga4?.leads)} |`);
    }
    const prov = weeks.find(w => w.ga4?.provisional);
    if (prov) L.push(`\\* provisional: GA4 reporting lags up to ${cfg.ga4?.provisionalLagHours ?? 48} hours; GA4 flags use the week of ${weekLabel(weeks[Math.max(0, weeks.indexOf(prov) - 1)].weekStart)}`);
    if (ga4Status !== 'ok') L.push('', `GA4: ${ga4Status}`);
  }

  // Search Console
  const gscStatus = sources?.gsc ?? 'not configured';
  L.push('', '## Search Console (US)');
  if (!gsc?.weeks?.length) L.push(gscStatus);
  else {
    const k = Math.min(cfg.report?.gscWeeks ?? 8, gsc.weeks.length);
    const shown = gsc.weeks.slice(gsc.weeks.length - k);
    const mark = w => `${weekLabel(w.weekStart)}${w.provisional ? '*' : ''}`;
    L.push(`| Week | Clicks | Impr | Brand impr | Brand clicks | Pos |`, sep(6));
    for (const w of shown) L.push(`| ${mark(w)} | ${cell(w.clicks)} | ${cell(w.impressions)} | ${cell(w.brand?.impressions)} | ${cell(w.brand?.clicks)} | ${cell(w.position)} |`);
    if (shown.some(w => w.provisional)) L.push(`\\* provisional: Search Console data lags about ${cfg.gsc?.provisionalLagDays ?? 3} days`);
    const t = gsc.topQueries;
    if (t?.rows) {
      L.push('', `## Top ${cfg.gsc?.topQueries ?? 25} queries by impressions · ${weekLabel(t.latestWeekStart)}${gsc.weeks[gsc.weeks.length - 1]?.provisional ? '*' : ''} vs ${weekLabel(t.priorWeekStart)}`);
      if (!t.rows.length) L.push('none');
      else {
        L.push('| Query | Impr | Prior | Clicks |', sep(4));
        for (const r of t.rows) L.push(`| ${r.query} | ${r.impressions} | ${r.prior} | ${r.clicks} |`);
      }
      const fmt = r => `${r.query} ${r.delta > 0 ? '+' : ''}${r.delta}`;
      if (t.up?.length || t.down?.length) L.push('', `Movers: up ${t.up.length ? t.up.map(fmt).join(', ') : 'none'} · down ${t.down.length ? t.down.map(fmt).join(', ') : 'none'}`);
    }
    if (gscStatus !== 'ok') L.push('', `Search Console: ${gscStatus}`);
  }

  L.push('', '## Flags');
  if (!flags.length) L.push('No flags'); else for (const f of flags) L.push(`- ${f.text}`);
  for (const i of report.info || []) L.push(`Info: ${i.text}`);   // demoted would-be flags: shown, never counted
  const v = sources?.vercel || {};
  const vercelLine = v.ok ? `Vercel ok (${v.queriesOk}/${v.queriesTotal} queries)` : `Vercel error (${(v.errors || []).map(e => `${e.query}: ${e.message}`).join('; ') || 'no data'})`;
  L.push('', `Sources: ${vercelLine} · GA4 ${ga4Status} · Search Console ${gscStatus}`);
  return L.join('\n') + '\n';
}
