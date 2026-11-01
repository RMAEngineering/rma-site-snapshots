// rma-site-snapshots — scripts/traffic.mjs
// Weekly traffic report from Vercel Web Analytics: the 8 most recent complete Monday–Sunday weeks (UTC), US-filtered,
// written next to the snapshot output so the publish step ships it with the gallery. All the logic is in
// scripts/traffic-lib.mjs; this file only loads config, calls the API and writes files.
//
// Env:
//   VERCEL_TOKEN   Vercel account token that can read the project's Web Analytics (repo secret in CI; required)
//   OUT_DIR        where traffic.json + traffic.md go (default out/latest)
//   HISTORY_DIR    one <weekStart>.json per complete week (default out/history/traffic)
//   TRAFFIC_NOW    test hook — ISO timestamp used as "now" for the window, e.g. 2026-10-26T12:00:00Z
//   TRAFFIC_FIXTURE_DIR  test hook — read <dir>/<query>.json (us, referrers, paths, countriesNoRef, chatgptPages; a raw
//                  API response or a bare rows array) instead of calling Vercel; a missing file plays a failed query
//
// Exit code is always 0. A failed query becomes a DATA_GAP flag with whatever data the other queries returned; a crash
// still writes a minimal traffic.json / traffic.md with DATA_GAP. This step must never block the snapshot publish.

import fs from 'node:fs/promises';
import path from 'node:path';
import { completeWeeks, queryDefs, buildQueryUrl, buildWeeks, computeFlags, renderMarkdown, isoDate } from './traffic-lib.mjs';

const cfg = JSON.parse(await fs.readFile(new URL('../traffic.config.json', import.meta.url), 'utf8'));
const OUT = process.env.OUT_DIR || 'out/latest';
const HIST = process.env.HISTORY_DIR || 'out/history/traffic';
const FIXTURES = process.env.TRAFFIC_FIXTURE_DIR || '';
const now = process.env.TRAFFIC_NOW ? new Date(process.env.TRAFFIC_NOW) : new Date();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[traffic]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.access(p).then(() => true, () => false);

// 429 and 5xx are retried with a short backoff; any other 4xx (401 bad token, 402 plan limit, 400 bad filter) is final.
// The token travels only in the Authorization header, never in the URL or in log lines.
async function vercelQuery(v, token, q, win) {
  const url = buildQueryUrl(v, q, win);
  const retries = v.retries ?? 2, timeoutMs = v.timeoutMs ?? 20000;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`.trim());
      const j = await r.json();
      const rows = j?.result?.data ?? j?.data;
      if (!Array.isArray(rows)) throw new Error('unexpected response shape');
      return rows;
    } catch (e) {
      if (/^HTTP 4/.test(e.message) || e.message === 'unexpected response shape') throw e;
      lastErr = e;   // network error / timeout: retry
    }
  }
  throw lastErr || new Error('query failed');
}

async function fixtureRows(name) {
  const j = JSON.parse(await fs.readFile(path.join(FIXTURES, `${name}.json`), 'utf8'));
  return Array.isArray(j) ? j : (j?.result?.data ?? j?.data ?? []);
}

async function main() {
  const win = completeWeeks(now, cfg.window?.weeks ?? 8);
  log(`window ${isoDate(win.since)} .. ${isoDate(win.until)} (${win.weekStarts.length} complete weeks; now ${now.toISOString()}${FIXTURES ? `; fixtures ${FIXTURES}` : ''})`);
  const token = process.env.VERCEL_TOKEN || '';
  const defs = queryDefs(cfg);
  const results = {}, errors = [];
  for (const [k, q] of Object.entries(defs)) {
    try {
      if (!FIXTURES && !token) throw new Error('VERCEL_TOKEN not set');
      results[k] = FIXTURES ? await fixtureRows(k) : await vercelQuery(cfg.vercel, token, q, win);
      log(`${k}: ${results[k].length} rows`);
    } catch (e) {
      results[k] = null;
      errors.push({ query: k, message: e.message });
      log(`${k}: FAILED ${e.message}`);
    }
  }

  const weeks = buildWeeks(win.weekStarts, results, cfg);
  const flags = computeFlags(weeks, cfg, errors);
  const total = Object.keys(defs).length;
  const report = {
    generatedAt: new Date().toISOString(),
    window: { weeks: win.weekStarts.length, since: win.since.toISOString(), until: win.until.toISOString(), weekStarts: win.weekStarts, latestWeekStart: win.weekStarts[win.weekStarts.length - 1] },
    sources: { vercel: { ok: errors.length === 0, queriesOk: total - errors.length, queriesTotal: total, errors, projectId: cfg.vercel.projectId } },
    flags,
    weeks,
  };
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'traffic.json'), JSON.stringify(report, null, 1));
  await fs.writeFile(path.join(OUT, 'traffic.md'), renderMarkdown(report, cfg));
  log(`wrote ${OUT}/traffic.json + traffic.md; flags: ${flags.map(f => f.code).join(', ') || 'none'}`);

  // History: one file per complete week. The newest week is (re)written on every successful refresh; older weeks in the
  // window are written only when their file is missing, so the first run backfills the whole window. Skipped entirely
  // when a query failed — a partial week must not become permanent history.
  if (errors.length) { log('history: skipped (a query failed)'); return; }
  await fs.mkdir(HIST, { recursive: true });
  let written = 0;
  for (const w of weeks) {
    const file = path.join(HIST, `${w.weekStart}.json`);
    const isLatest = w.weekStart === report.window.latestWeekStart;
    if (!isLatest && await exists(file)) continue;
    await fs.writeFile(file, JSON.stringify({ weekStart: w.weekStart, weekEnd: w.weekEnd, generatedAt: report.generatedAt, flags: isLatest ? flags : null, week: w }, null, 1));
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
    await fs.writeFile(path.join(OUT, 'traffic.json'), JSON.stringify({ generatedAt, window: null, sources: { vercel: { ok: false, queriesOk: 0, queriesTotal: 0, errors: [{ query: 'script', message }] } }, flags: [{ code: 'DATA_GAP', text: `DATA_GAP: script failed (${message})` }], weeks: [] }, null, 1));
    await fs.writeFile(path.join(OUT, 'traffic.md'), `# Weekly traffic · generated ${generatedAt.replace('T', ' ').slice(0, 16)} UTC · no data · 1 flag\n\n## Flags\n- DATA_GAP: script failed (${message})\n\nSources: Vercel error (script: ${message})\n`);
  } catch { /* nothing left to do */ }
}
process.exitCode = 0;
