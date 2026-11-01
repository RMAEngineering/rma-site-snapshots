// rma-site-snapshots — scripts/traffic.mjs
// Weekly traffic report: Vercel Web Analytics (the 8 most recent complete Monday–Sunday weeks, US), GA4 (same 8 weeks,
// US) and Search Console (16 weeks, US), written next to the snapshot output so the publish step ships it with the
// gallery. All the logic is in scripts/traffic-lib.mjs; this file only loads config, calls the APIs and writes files.
//
// Env:
//   VERCEL_TOKEN   Vercel account token that can read the project's Web Analytics (repo secret in CI; required)
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
//                  desktop OAuth client + refresh token minted once by scripts/google-auth-once.mjs. All three, or the
//                  Google sources are skipped cleanly (sources.ga4 / sources.gsc = "not configured").
//   GA4_PROPERTY_ID  numeric GA4 property id (not the G-… measurement id); missing -> sources.ga4 = "not configured"
//   OUT_DIR        where traffic.json + traffic.md go (default out/latest)
//   HISTORY_DIR    one <weekStart>.json per complete week (default out/history/traffic)
//   TRAFFIC_NOW    test hook — ISO timestamp used as "now" for the window, e.g. 2026-10-26T12:00:00Z
//   TRAFFIC_FIXTURE_DIR  test hook — read <dir>/<query>.json instead of calling the APIs; a missing file plays a failed
//                  query. Vercel: us, referrers, paths, countriesNoRef, chatgptPages (raw response or rows array).
//                  Google (read only when the three GOOGLE_OAUTH_* variables are set to anything; the token swap is
//                  skipped): ga4-sources, ga4-events (raw runReport responses), gsc-weekly, gsc-brand, gsc-top-latest,
//                  gsc-top-prior (raw searchAnalytics responses or rows arrays).
//
// Exit code is always 0. A failed query becomes a DATA_GAP flag with whatever data the other queries returned; a crash
// still writes a minimal traffic.json / traffic.md with DATA_GAP. This step must never block the snapshot publish.
// Tokens travel only in headers and POST bodies, never in URLs or log lines.

import fs from 'node:fs/promises';
import path from 'node:path';
import { completeWeeks, queryDefs, buildQueryUrl, buildWeeks, computeFlags, renderMarkdown, isoDate, weekEndOf,
  normalizeGa4, buildGa4Weeks, ga4SourcesRequest, ga4EventsRequest, gscRequest, buildGscWeeks, topQueryMovers } from './traffic-lib.mjs';

const cfg = JSON.parse(await fs.readFile(new URL('../traffic.config.json', import.meta.url), 'utf8'));
const OUT = process.env.OUT_DIR || 'out/latest';
const HIST = process.env.HISTORY_DIR || 'out/history/traffic';
const FIXTURES = process.env.TRAFFIC_FIXTURE_DIR || '';
const now = process.env.TRAFFIC_NOW ? new Date(process.env.TRAFFIC_NOW) : new Date();
const NOT_CONFIGURED = 'not configured';
const TOKEN_EXPIRED = 'refresh token expired — rerun google-auth-once';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[traffic]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.access(p).then(() => true, () => false);
const isFinal4xx = e => /^HTTP 4/.test(e.message) || e.message === 'unexpected response shape';

// 429 and 5xx are retried with a short backoff; any other 4xx (401 bad token, 402 plan limit, 400 bad filter) is final.
async function fetchJson(url, init, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`.trim());
      return await r.json();
    } catch (e) {
      if (isFinal4xx(e)) throw e;
      lastErr = e;   // network error / timeout: retry
    }
  }
  throw lastErr || new Error('request failed');
}

async function vercelQuery(v, token, q, win) {
  const j = await fetchJson(buildQueryUrl(v, q, win), { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, { retries: v.retries ?? 2, timeoutMs: v.timeoutMs ?? 20000 });
  const rows = j?.result?.data ?? j?.data;
  if (!Array.isArray(rows)) throw new Error('unexpected response shape');
  return rows;
}

const googlePost = (url, body, token, g) => fetchJson(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, { retries: g.retries ?? 2, timeoutMs: g.timeoutMs ?? 30000 });

// refresh token -> short-lived access token. invalid_grant (expired / revoked refresh token) is reported by its name so
// the caller can print the fix; the response body is never logged (it would carry the access token on success).
async function googleAccessToken(g, creds) {
  const r = await fetch(g.tokenEndpoint || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(g.timeoutMs ?? 30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const code = j.error || `HTTP ${r.status}`;
    const e = new Error(code === 'invalid_grant' ? TOKEN_EXPIRED : `token exchange failed (${code}${j.error_description ? `: ${j.error_description}` : ''})`);
    e.code = code;
    throw e;
  }
  return j.access_token;
}

async function fixtureJson(name) { return JSON.parse(await fs.readFile(path.join(FIXTURES, `${name}.json`), 'utf8')); }
const fixtureRows = async name => { const j = await fixtureJson(name); return Array.isArray(j) ? j : (j?.result?.data ?? j?.data ?? []); };

// run a set of named queries, never throwing: results[key] = data or null, plus one error entry per failure
async function runAll(prefix, tasks, errors) {
  const results = {};
  for (const [key, fn] of Object.entries(tasks)) {
    try { results[key] = await fn(); log(`${prefix}:${key}: ok`); }
    catch (e) { results[key] = null; errors.push({ query: `${prefix}:${key}`, message: e.message }); log(`${prefix}:${key}: FAILED ${e.message}`); }
  }
  return results;
}
const statusOf = (errs, prefix) => errs.length ? `error: ${errs.map(e => `${e.query.slice(prefix.length + 1)} ${e.message}`).join('; ')}` : 'ok';

async function main() {
  const win = completeWeeks(now, cfg.window?.weeks ?? 8);
  log(`window ${isoDate(win.since)} .. ${isoDate(win.until)} (${win.weekStarts.length} complete weeks; now ${now.toISOString()}${FIXTURES ? `; fixtures ${FIXTURES}` : ''})`);

  // ---- Vercel
  const vercelToken = process.env.VERCEL_TOKEN || '';
  const defs = queryDefs(cfg);
  const vercelErrors = [];
  const results = await runAll('vercel', Object.fromEntries(Object.entries(defs).map(([k, q]) => [k, async () => {
    if (!FIXTURES && !vercelToken) throw new Error('VERCEL_TOKEN not set');
    return FIXTURES ? fixtureRows(k) : vercelQuery(cfg.vercel, vercelToken, q, win);
  }])), vercelErrors);
  const weeks = buildWeeks(win.weekStarts, results, cfg);

  // ---- Google (GA4 + Search Console): all three OAuth values or nothing; GA4 also needs the property id
  const creds = { clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(), clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(), refreshToken: (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim() };
  const ga4Property = (process.env.GA4_PROPERTY_ID || '').trim();
  const googleConfigured = Boolean(creds.clientId && creds.clientSecret && creds.refreshToken);
  const googleErrors = [];
  let ga4Status = NOT_CONFIGURED, gscStatus = NOT_CONFIGURED;
  let ga4Data = { sources: null, events: null };
  let gscData = { daily: null, brandDaily: null, topLatest: null, topPrior: null };
  const gscWin = completeWeeks(now, cfg.gsc?.weeks ?? 16);
  if (!googleConfigured) log('google: not configured (GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN missing) — GA4 and Search Console skipped');
  else {
    let token = null;
    try { token = FIXTURES ? 'fixture' : await googleAccessToken(cfg.google || {}, creds); log('google: access token ok'); }
    catch (e) {
      ga4Status = gscStatus = `error: ${e.message}`;
      googleErrors.push({ query: 'google:token', message: e.message });
      log(`google: token FAILED ${e.message}`);
    }
    if (token) {
      const g = cfg.google || {};
      // GA4
      if (!ga4Property) { log('ga4: not configured (GA4_PROPERTY_ID missing)'); }
      else {
        const url = `${cfg.ga4?.endpoint || 'https://analyticsdata.googleapis.com/v1beta'}/properties/${encodeURIComponent(ga4Property)}:runReport`;
        const report = async (fixture, body) => normalizeGa4(FIXTURES ? await fixtureJson(fixture) : await googlePost(url, body, token, g));
        const errs = [];
        ga4Data = await runAll('ga4', {
          sources: () => report('ga4-sources', ga4SourcesRequest(win, cfg)),
          events:  () => report('ga4-events', ga4EventsRequest(win, cfg)),
        }, errs);
        googleErrors.push(...errs);
        ga4Status = statusOf(errs, 'ga4');
      }
      // Search Console
      {
        const url = `${cfg.gsc?.endpoint || 'https://www.googleapis.com/webmasters/v3'}/sites/${encodeURIComponent(cfg.gsc?.siteUrl || '')}/searchAnalytics/query`;
        const query = async (fixture, body) => FIXTURES ? fixtureJson(fixture) : googlePost(url, body, token, g);
        const ws = gscWin.weekStarts, latestWs = ws[ws.length - 1], priorWs = ws[ws.length - 2];
        const range = { start: ws[0], end: weekEndOf(latestWs) };
        const errs = [];
        gscData = await runAll('gsc', {
          daily:      () => query('gsc-weekly', gscRequest(range, { dimensions: ['date'] }, cfg)),
          brandDaily: () => query('gsc-brand', gscRequest(range, { dimensions: ['date'], brand: true }, cfg)),
          topLatest:  () => query('gsc-top-latest', gscRequest({ start: latestWs, end: weekEndOf(latestWs) }, { dimensions: ['query'], rowLimit: cfg.gsc?.topQueriesFetch ?? 500 }, cfg)),
          topPrior:   () => query('gsc-top-prior', gscRequest({ start: priorWs, end: weekEndOf(priorWs) }, { dimensions: ['query'], rowLimit: cfg.gsc?.topQueriesFetch ?? 500 }, cfg)),
        }, errs);
        googleErrors.push(...errs);
        gscStatus = statusOf(errs, 'gsc');
      }
    }
  }

  // ---- assemble
  const ga4Weeks = buildGa4Weeks(win.weekStarts, ga4Data, cfg);
  weeks.forEach((w, i) => { w.ga4 = ga4Weeks[i]; });
  const gscWeeks = (gscData.daily || gscData.brandDaily) ? buildGscWeeks(gscWin.weekStarts, gscData, cfg, now) : null;
  const ws16 = gscWin.weekStarts;
  const topQueries = (gscData.topLatest || gscData.topPrior) ? { latestWeekStart: ws16[ws16.length - 1], priorWeekStart: ws16[ws16.length - 2], ...topQueryMovers(gscData.topLatest, gscData.topPrior, cfg) } : null;
  const gsc = (gscWeeks || topQueries) ? { siteUrl: cfg.gsc?.siteUrl || null, weeks: gscWeeks || [], provisionalWeekStart: gscWeeks?.find(w => w.provisional)?.weekStart ?? null, topQueries } : null;
  const errors = [...vercelErrors, ...googleErrors];
  const flags = computeFlags(weeks, cfg, errors, { gscWeeks, ga4Ok: ga4Status === 'ok' });
  const total = Object.keys(defs).length;
  const report = {
    generatedAt: new Date().toISOString(),
    window: { weeks: win.weekStarts.length, since: win.since.toISOString(), until: win.until.toISOString(), weekStarts: win.weekStarts, latestWeekStart: win.weekStarts[win.weekStarts.length - 1], gscWeeks: ws16.length, gscSince: ws16[0] },
    sources: {
      vercel: { ok: vercelErrors.length === 0, queriesOk: total - vercelErrors.length, queriesTotal: total, errors: vercelErrors, projectId: cfg.vercel.projectId },
      ga4: ga4Status,
      gsc: gscStatus,
      google: { configured: googleConfigured, ga4PropertyConfigured: Boolean(ga4Property), siteUrl: cfg.gsc?.siteUrl || null, errors: googleErrors },
    },
    flags,
    weeks,
    gsc,
  };
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'traffic.json'), JSON.stringify(report, null, 1));
  await fs.writeFile(path.join(OUT, 'traffic.md'), renderMarkdown(report, cfg));
  log(`wrote ${OUT}/traffic.json + traffic.md; ga4 ${ga4Status}; gsc ${gscStatus}; flags: ${flags.map(f => f.code).join(', ') || 'none'}`);

  // History: one file per complete week of the Vercel window. The newest week is (re)written on every successful
  // refresh; older weeks are written only when their file is missing, so the first run backfills the whole window.
  // Skipped when a Vercel query failed — a partial week must not become permanent history. A Google failure does not
  // block it: the file just carries null GA4 / Search Console fields and the two status strings.
  if (vercelErrors.length) { log('history: skipped (a Vercel query failed)'); return; }
  await fs.mkdir(HIST, { recursive: true });
  let written = 0;
  for (const w of weeks) {
    const file = path.join(HIST, `${w.weekStart}.json`);
    const isLatest = w.weekStart === report.window.latestWeekStart;
    if (!isLatest && await exists(file)) continue;
    const gscWeek = gscWeeks?.find(g => g.weekStart === w.weekStart) ?? null;
    await fs.writeFile(file, JSON.stringify({ weekStart: w.weekStart, weekEnd: w.weekEnd, generatedAt: report.generatedAt, flags: isLatest ? flags : null, sources: { ga4: ga4Status, gsc: gscStatus }, week: w, gsc: gscWeek }, null, 1));
    written++;
  }
  log(`history: ${written} file(s) written to ${HIST}`);
}

try {
  await main();
} catch (e) {
  log('CRASH', e?.stack || e);
  try {
    const message = String(e?.message || e);
    const generatedAt = new Date().toISOString();
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'traffic.json'), JSON.stringify({ generatedAt, window: null, sources: { vercel: { ok: false, queriesOk: 0, queriesTotal: 0, errors: [{ query: 'script', message }] }, ga4: `error: script failed (${message})`, gsc: `error: script failed (${message})` }, flags: [{ code: 'DATA_GAP', text: `DATA_GAP: script failed (${message})` }], weeks: [], gsc: null }, null, 1));
    await fs.writeFile(path.join(OUT, 'traffic.md'), `# Weekly traffic · generated ${generatedAt.replace('T', ' ').slice(0, 16)} UTC · no data · 1 flag\n\n## Flags\n- DATA_GAP: script failed (${message})\n\nSources: Vercel error (script: ${message}) · GA4 error · Search Console error\n`);
  } catch { /* nothing left to do */ }
}
process.exitCode = 0;
