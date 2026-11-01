// rma-site-snapshots — scripts/traffic-lib.mjs
// Pure helpers for the weekly traffic report: the complete-week window, the five Vercel query definitions and their
// URLs, bucketing of Vercel Web Analytics rows into per-week records, the flag rules and the traffic.md renderer.
// No network and no fs, so `npm test` (tests/traffic.test.mjs) covers them without a token. scripts/traffic.mjs is the
// thin runner around these.
//
// Vercel rows look like { timestamp: "2026-10-19T00:00:00.000Z", visitors: 58, pageviews: 114, <dimension>: value } —
// one row per (week, dimension value), zero rows included; the dimension key is the `by` name (referrerHostname,
// requestPath, country); "" is "no referrer"; everything past `limit` is folded into one value "Others". Visitors are
// unique per row, so sums across rows (page groups, per-path lists) count a person once per page; pageviews add exactly.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const OVERFLOW = 'Others';
export const isoDate = d => new Date(d).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const weekLabel = ws => { const d = new Date(ws + 'T00:00:00.000Z'); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const num = x => (typeof x === 'number' && Number.isFinite(x)) ? x : (Number(x) || 0);
const round = (x, p) => x == null ? null : Math.round(x * 10 ** p) / 10 ** p;

// ---------------------------------------------------------------- week math (weeks start Monday 00:00 UTC)
export function mondayOf(d) {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t;
}
export const weekEndOf = ws => isoDate(new Date(ws + 'T00:00:00.000Z').getTime() + 6 * 86400000);

// The n most recent COMPLETE Monday–Sunday weeks as of `now`; the week containing `now` is never one of them.
// `until` is the last millisecond of the newest complete week: Vercel treats `until` as inclusive and widens it to the
// granularity, so a Monday-00:00 `until` would pull in the partial current week as a ninth row.
export function completeWeeks(now, n) {
  const current = mondayOf(now);
  const weekStarts = Array.from({ length: n }, (_, i) => isoDate(current.getTime() - (n - i) * WEEK_MS));
  return { since: new Date(current.getTime() - n * WEEK_MS), until: new Date(current.getTime() - 1), weekStarts };
}

// ---------------------------------------------------------------- queries
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

// ---------------------------------------------------------------- normalization + bucketing
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

// ---------------------------------------------------------------- flags
// Newest complete week vs the mean of the `baselineWeeks` weeks before it. Every threshold comes from cfg.thresholds.
// A ratio flag needs a baseline mean > 0 (a comparison against nothing says nothing) and a present latest value.
const get = {
  usVisitors:        w => w.us?.visitors ?? null,
  usNoRefVisitors:   w => w.referrers?.['']?.visitors ?? null,
  deepPagesVisitors: w => w.groups?.deepPages?.visitors ?? null,
  adPagesVisitors:   w => w.groups?.adPages?.visitors ?? null,
  chatgptVisitors:   w => w.referrers?.['chatgpt.com']?.visitors ?? null,
};
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function computeFlags(weeks, cfg, errors = []) {
  const T = cfg.thresholds || {};
  const nBase = cfg.window?.baselineWeeks ?? 4;
  const flags = [];
  const latest = weeks[weeks.length - 1];
  const base = weeks.slice(Math.max(0, weeks.length - 1 - nBase), weeks.length - 1);
  if (latest) {
    const ratioFlag = (code, label, getter, threshold, dir) => {
      const cur = getter(latest);
      const xs = base.map(getter).filter(x => typeof x === 'number');
      const avg = mean(xs);
      if (cur == null || avg == null || avg <= 0 || typeof threshold !== 'number') return;
      const ratio = cur / avg;
      if (dir === 'down' ? ratio <= threshold : ratio >= threshold) {
        flags.push({ code, latest: cur, avg: round(avg, 1), ratio: round(ratio, 2), threshold, baselineWeeks: xs.length,
          text: `${code}: ${label} ${cur}, prior ${xs.length}-week avg ${round(avg, 1)}, ratio ${round(ratio, 2)} (flag ${dir === 'down' ? '<=' : '>='} ${threshold})` });
      }
    };
    ratioFlag('US_NOREF_DOWN', 'US no-referrer visitors', get.usNoRefVisitors, T.usNoRefDownRatio, 'down');
    ratioFlag('DEEP_PAGES_DOWN', 'deep-page visitors', get.deepPagesVisitors, T.deepPagesDownRatio, 'down');
    const zeroWeeks = T.chatgptZeroWeeks ?? 2, maxAtLeast = T.chatgptMaxAtLeast ?? 3;
    const gpt = weeks.map(get.chatgptVisitors);
    if (gpt.length >= zeroWeeks && gpt.every(x => typeof x === 'number')) {
      const tail = gpt.slice(-zeroWeeks), max = Math.max(...gpt);
      if (tail.every(x => x === 0) && max >= maxAtLeast) {
        flags.push({ code: 'CHATGPT_ZERO', latest: tail, max, threshold: maxAtLeast, zeroWeeks,
          text: `CHATGPT_ZERO: chatgpt.com visitors ${tail.join(', ')} in the last ${zeroWeeks} weeks; ${weeks.length}-week max ${max} (flag >= ${maxAtLeast})` });
      }
    }
    ratioFlag('AD_PAGES_DOWN', 'ad-page visitors', get.adPagesVisitors, T.adPagesDownRatio, 'down');
    ratioFlag('TRAFFIC_UP', 'US visitors', get.usVisitors, T.trafficUpRatio, 'up');
    const share = latest.botShareNoReferrer;
    if (typeof share === 'number' && typeof T.botShareSpike === 'number' && share >= T.botShareSpike) {
      flags.push({ code: 'BOT_SPIKE', latest: share, threshold: T.botShareSpike, nonUs: latest.noReferrer.nonUs, total: latest.noReferrer.total,
        text: `BOT_SPIKE: non-US share of no-referrer visitors ${share} (${latest.noReferrer.nonUs}/${latest.noReferrer.total}; flag >= ${T.botShareSpike})` });
    }
  }
  const zeroUs = weeks.filter(w => w.us && w.us.visitors === 0).map(w => w.weekStart);
  if (errors.length || zeroUs.length) {
    const parts = errors.map(e => `query ${e.query} failed (${e.message})`);
    if (zeroUs.length) parts.push(`0 US visitors in week${zeroUs.length > 1 ? 's' : ''} ${zeroUs.join(', ')}`);
    flags.push({ code: 'DATA_GAP', failedQueries: errors.map(e => e.query), zeroUsWeeks: zeroUs, text: `DATA_GAP: ${parts.join('; ')}` });
  }
  return flags;
}

// ---------------------------------------------------------------- traffic.md
// Phone-sized: one header line, the 8-week table, deep pages by page for the last N weeks, flags, sources. Numbers only.
export function renderMarkdown(report, cfg) {
  const { generatedAt, window, weeks, flags, sources } = report;
  const cols = cfg.report?.pageColumns || ['/contact-us', '/inventors'];
  const cell = v => v == null ? '-' : String(v);
  const pct = v => v == null ? '-' : `${Math.round(v * 100)}%`;
  const pageCell = (w, p) => cell(w.pages ? (w.pages[p]?.visitors ?? 0) : null);
  const gen = String(generatedAt).replace('T', ' ').slice(0, 16) + ' UTC';
  const first = window.weekStarts[0], last = window.weekStarts[window.weekStarts.length - 1];
  const L = [];
  L.push(`# Weekly traffic · generated ${gen} · ${window.weeks} weeks ${weekLabel(first)} to ${weekLabel(weekEndOf(last))} · ${flags.length} flag${flags.length === 1 ? '' : 's'}`);
  L.push('', `| Week | US vis | NoRef vis | NoRef pv | Google | ChatGPT | Deep | ${cols.join(' | ')} | Bot |`, `|${'---|'.repeat(8 + cols.length)}`);
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
    L.push(`| Page | ${recent.map(w => weekLabel(w.weekStart)).join(' | ')} |`, `|${'---|'.repeat(1 + recent.length)}`);
    for (const [p] of [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) L.push(`| ${p} | ${recent.map(w => pageCell(w, p)).join(' | ')} |`);
  }
  L.push('', '## Flags');
  if (!flags.length) L.push('No flags'); else for (const f of flags) L.push(`- ${f.text}`);
  const v = sources?.vercel || {};
  L.push('', v.ok ? `Sources: Vercel ok (${v.queriesOk}/${v.queriesTotal} queries)` : `Sources: Vercel error (${(v.errors || []).map(e => `${e.query}: ${e.message}`).join('; ') || 'no data'})`);
  return L.join('\n') + '\n';
}
