// rma-site-snapshots — scripts/snapshot.mjs
// Renders every page in the sitemap at desktop + mobile, runs structural checks,
// an accessibility scan, an internal-link check and a pixel diff against the
// previous run. Writes everything to OUT_DIR (default: out/latest).
//
// Env:
//   SITE_URL   override baseUrl from pages.config.json
//   OUT_DIR    output folder (default out/latest)
//   PREV_DIR   previous run folder for diffs (default previous/latest; optional)
//   ONLY_PAGES comma-separated paths to limit the run (optional)
//   BANNED_PHRASES_EXTRA  comma-separated phrases added to pages.config.json bannedPhrases for this run (test hook)
//   SIMULATE_CHUNK_FAIL   once|always — fail the first /_next/static/chunks/*.js request to exercise the retry (test hook)
//
// Outputs:
//   manifest.json            machine-readable results (Claude reads this first)
//   report.md                human-readable summary with ALERTS at the top
//   index.html               mobile-friendly gallery (served via GitHub Pages)
//   pages/<slug>/desktop_fold.jpg | mobile_fold.jpg | desktop_full.jpg | mobile_full.jpg
//   pages/<slug>/fold.jpg    desktop + mobile fold side by side (Claude reads this)
//   pages/<slug>/full.jpg    top of desktop + mobile full page side by side (Claude reads this)
//   pages/<slug>/*_diff.jpg  pixel diff vs previous run, only when it changed

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { summarizeAxe, dedupeSitewideA11y } from './a11y.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');
// no libvips cache: a retried view overwrites the files that the pass-1 diff already read; cached open handles would
// block that write on Windows and a cached decode could feed pass-1 pixels into the pass-2 diff. Nothing here reuses an input.
sharp.cache(false);
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
let AxeBuilder = null;
try { AxeBuilder = require('@axe-core/playwright').default; } catch { /* optional */ }

const cfg = JSON.parse(await fs.readFile(new URL('../pages.config.json', import.meta.url), 'utf8'));
const BASE = (process.env.SITE_URL || cfg.baseUrl).replace(/\/$/, '');
const OUT = process.env.OUT_DIR || 'out/latest';
const PREV = process.env.PREV_DIR || 'previous/latest';
const ONLY = (process.env.ONLY_PAGES || '').split(',').map(s => s.trim()).filter(Boolean);
const T = cfg.thresholds;
// analytics/ad beacons and Next.js RSC prefetches are routinely cancelled when the page moves on; not a site fault
const IGNORE_ABORTED = (cfg.ignoreAbortedRequests || []).map(p => new RegExp(p, 'i'));
// copy that must never appear on the site (checked case-insensitively against each page's visible text);
// allowPhrases are legitimate uses: a banned match is ignored when an allow phrase sits within 40 chars of it
const BANNED = [...(cfg.bannedPhrases || []), ...(process.env.BANNED_PHRASES_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean)];
const ALLOW = cfg.allowPhrases || [];
// an axe (rule, selector) pair failing on at least this share of scanned pages is reported once as "sitewide"
const SITEWIDE_SHARE = cfg.axe?.sitewideShare ?? 0.5;
const isChunkUrl = u => u.startsWith(BASE + '/_next/static/');   // first-party Next.js build asset (deploy skew shows up here)
const startedAt = new Date();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const slugOf = p => p === '/' ? 'home' : p.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-z0-9_-]/gi, '');
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;

// ---------------------------------------------------------------- page list
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'rma-site-snapshots/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function sitemapEntries(url, depth = 0) {
  const xml = await fetchText(url);
  if (/<sitemapindex/i.test(xml) && depth < 2) {
    const subs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
    const all = [];
    for (const s of subs) all.push(...await sitemapEntries(s, depth + 1));
    return all;
  }
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m => {
    const loc = (m[1].match(/<loc>(.*?)<\/loc>/) || [])[1]?.trim();
    const lastmod = (m[1].match(/<lastmod>(.*?)<\/lastmod>/) || [])[1]?.trim() || '';
    return { loc, lastmod };
  }).filter(e => e.loc);
}
async function getPages() {
  if (ONLY.length) return ONLY;
  let entries = [];
  try { entries = await sitemapEntries(BASE + cfg.sitemapPath); }
  catch (e) { log('sitemap failed:', e.message); }
  const toPath = loc => { try { const u = new URL(loc); return (u.pathname.replace(/\/$/, '') || '/'); } catch { return null; } };
  let paths = entries.map(e => ({ path: toPath(e.loc), lastmod: e.lastmod })).filter(e => e.path);
  const excl = (cfg.excludePatterns || []).map(p => new RegExp(p));
  paths = paths.filter(e => !excl.some(r => r.test(e.path)));
  for (const cap of cfg.capPatterns || []) {
    const r = new RegExp(cap.pattern);
    const matched = paths.filter(e => r.test(e.path)).sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));
    const keep = new Set(matched.slice(0, cap.max).map(e => e.path));
    paths = paths.filter(e => !r.test(e.path) || keep.has(e.path));
  }
  const list = paths.map(e => e.path);
  for (const p of cfg.extraPaths || []) if (!list.includes(p)) list.push(p);
  // key pages first so partial runs still cover what matters
  const key = cfg.keyPages || [];
  return [...new Set([...key.filter(k => list.includes(k)), ...list])];
}

// ---------------------------------------------------------------- in-page metrics
function pageMetrics({ ctaPatterns, vw, bannedPhrases, allowPhrases }) {
  const txt = e => (e && e.textContent || '').trim().replace(/\s+/g, ' ');
  const re = Object.fromEntries(Object.entries(ctaPatterns).map(([k, v]) => [k, new RegExp(v, 'i')]));
  const links = [...document.querySelectorAll('a[href]')];
  const hrefs = links.map(a => a.getAttribute('href') || '');
  const cta = Object.fromEntries(Object.keys(re).map(k => [k, hrefs.filter(h => re[k].test(h)).length]));
  const suspicious = links.filter(a => { const h = (a.getAttribute('href') || '').trim(); return h === '' || h === '#' || h === '&' || h.startsWith('/&') || /^javascript:/i.test(h); })
    .slice(0, 10).map(a => ({ href: a.getAttribute('href'), text: txt(a).slice(0, 60) }));
  const internal = [...new Set(hrefs.filter(h => h.startsWith('/') && !h.startsWith('//')).map(h => h.split('#')[0]))];
  const external = [...new Set(hrefs.filter(h => /^https?:\/\//.test(h) && !h.includes(location.hostname)))];
  const se = document.scrollingElement;
  const overflow = se.scrollWidth > se.clientWidth + 1;
  const overflowEls = overflow ? [...document.querySelectorAll('body *')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.right > vw + 1 && r.width > 0; }).slice(0, 5)
    .map(e => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ').slice(0, 2).join('.') : '')) : [];
  const imgs = [...document.images];
  const oversized = imgs.filter(i => i.naturalWidth > 0 && i.clientWidth > 80 && i.naturalWidth > 2 * i.clientWidth)
    .map(i => `${i.naturalWidth}x${i.naturalHeight} shown at ${i.clientWidth}px: ${(i.currentSrc || i.src || '').replace(/^.*\/image\?url=/, '').split('&')[0].slice(0, 70)}`);
  const brokenImgs = imgs.filter(i => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map(i => (i.currentSrc || i.src).slice(0, 100));
  const fixed = [...document.querySelectorAll('body *')].filter(e => { const cs = getComputedStyle(e); return (cs.position === 'fixed' || cs.position === 'sticky') && e.getBoundingClientRect().height > 0; })
    .slice(0, 6).map(e => `${e.tagName.toLowerCase()} h${Math.round(e.getBoundingClientRect().height)} top${Math.round(e.getBoundingClientRect().top)}`);
  const inter = [...document.querySelectorAll('a,button,input,select,textarea')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const smallTap = inter.filter(e => { const r = e.getBoundingClientRect(); return r.height < 32 || r.width < 32; }).length;
  const main = document.querySelector('main') || document.body;
  const foldH = window.innerHeight;
  const foldText = [...document.querySelectorAll('h1,h2,h3,p,a,button')].filter(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < foldH && r.height > 0 && txt(e).length > 2; })
    .slice(0, 10).map(e => `${e.tagName.toLowerCase()}: ${txt(e).slice(0, 90)}`);
  const nav = performance.getEntriesByType('navigation')[0];
  // banned copy: the whole visible page (header/footer hold the email, BBB rating and reply promise), innerText so that
  // hidden drawers, <script>/JSON-LD and display:none responsive variants are excluded. Word-boundary guards only where
  // the phrase starts/ends with a word char ("A+" must not match "DATA+"). A match is dropped when an allow phrase
  // appears within 40 chars of it ("12-hour time zone" is not the old "12-hour reply" claim).
  const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowRes = (allowPhrases || []).map(a => new RegExp(reEsc(a), 'i'));
  const bannedHits = (bannedPhrases || []).map(phrase => {
    const re = new RegExp((/^\w/.test(phrase) ? '(?<!\\w)' : '') + reEsc(phrase) + (/\w$/.test(phrase) ? '(?!\\w)' : ''), 'gi');
    const hits = [...bodyText.matchAll(re)]
      .filter(h => !allowRes.some(a => a.test(bodyText.slice(Math.max(0, h.index - 40), h.index + phrase.length + 40))));
    if (!hits.length) return null;
    const i = hits[0].index;
    return { phrase, count: hits.length, snippet: bodyText.slice(Math.max(0, i - 45), i + phrase.length + 45).trim() };
  }).filter(Boolean);
  return {
    title: document.title,
    metaDescLen: ((document.querySelector('meta[name=description]') || {}).content || '').length,
    canonical: (document.querySelector('link[rel=canonical]') || {}).href || '',
    robots: [...document.querySelectorAll('meta[name=robots]')].map(m => m.content).join(' | '),
    ogImage: !!document.querySelector('meta[property="og:image"]'),
    h1s: [...document.querySelectorAll('h1')].map(txt),
    h2s: [...document.querySelectorAll('h2')].map(txt).slice(0, 20),
    words: txt(main).split(' ').filter(Boolean).length,
    cta, suspiciousLinks: suspicious, internalLinks: internal, externalLinkCount: external.length,
    overflow, overflowEls, imgCount: imgs.length, noAlt: imgs.filter(i => !i.alt).length, oversized, brokenImgs,
    fixed, smallTap, interactive: inter.length,
    forms: document.querySelectorAll('form').length,
    inputs: document.querySelectorAll('input:not([type=hidden]),textarea,select').length,
    foldText, docH: document.documentElement.scrollHeight,
    ttfbMs: nav ? Math.round(nav.responseStart) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    bannedHits,
  };
}

// ---------------------------------------------------------------- image helpers
async function toJpeg(pngBuf, file, quality = 72) {
  await sharp(pngBuf).jpeg({ quality, mozjpeg: true }).toFile(file);
}
async function sideBySide(aBuf, bBuf, file, gap = 24) {
  const [A, B] = await Promise.all([sharp(aBuf).metadata(), sharp(bBuf).metadata()]);
  await sharp({ create: { width: A.width + gap + B.width, height: Math.max(A.height, B.height), channels: 3, background: '#e5e7eb' } })
    .composite([{ input: aBuf, left: 0, top: 0 }, { input: bBuf, left: A.width + gap, top: 0 }])
    .jpeg({ quality: 72, mozjpeg: true }).toFile(file);
}
async function topCrop(buf, width, maxH) {
  const resized = await sharp(buf).resize({ width }).toBuffer();
  const m = await sharp(resized).metadata();
  return m.height > maxH ? sharp(resized).extract({ left: 0, top: 0, width, height: maxH }).toBuffer() : resized;
}
async function diffImages(curFile, prevFile, outFile, width) {
  if (!fss.existsSync(prevFile)) return null;
  const load = async f => { const img = sharp(f, { limitInputPixels: false }).resize({ width }).ensureAlpha(); const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
  const [a, b] = await Promise.all([load(curFile), load(prevFile)]);
  const h = Math.min(a.h, b.h), w = Math.min(a.w, b.w);
  const crop = (img) => { if (img.w === w && img.h === h) return img.data; const out = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.w * 4, y * img.w * 4 + w * 4); return out; };
  const da = crop(a), db = crop(b), diff = Buffer.alloc(w * h * 4);
  const changed = pixelmatch(da, db, diff, w, h, { threshold: 0.15, includeAA: false, alpha: 0.25 });
  const pctChanged = pct(changed, w * h);
  const heightChange = b.h ? (a.h - b.h) / b.h : 0;
  if (pctChanged >= 0.5) await sharp(diff, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 60 }).toFile(outFile);
  return { pctChanged, heightChange: Math.round(heightChange * 1000) / 1000, prevHeight: b.h, curHeight: a.h, diffFile: pctChanged >= 0.5 ? path.basename(outFile) : null };
}

// ---------------------------------------------------------------- main
const pages = await getPages();
log(`base ${BASE} · ${pages.length} pages · out ${OUT} · prev ${fss.existsSync(PREV) ? PREV : '(none)'}`);
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
const allInternal = new Set();

for (const p of pages) {
  const slug = slugOf(p);
  const dir = path.join(OUT, 'pages', slug);
  await fs.mkdir(dir, { recursive: true });
  const entry = { path: p, slug, url: BASE + p, views: {}, flags: [] };

  for (const [vname, v] of Object.entries(cfg.viewports)) {
    let firstAttemptChunkFailures = null;              // set when pass 1 saw a first-party /_next/static failure
    for (let pass = 1; pass <= 2; pass++) {            // pass 2 only happens after a chunk failure, in a fresh context
      const context = await browser.newContext({
        viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale,
        isMobile: !!v.mobile, hasTouch: !!v.mobile, userAgent: v.userAgent, locale: 'en-US', timezoneId: 'America/New_York',
      });
      const page = await context.newPage();
      // LCP is only delivered to a PerformanceObserver (performance.getEntriesByType never returns it); install before navigation
      await page.addInitScript(() => {
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) { window.__lcp = e.startTime; window.__lcpEl = `${e.element?.tagName || '?'}${e.url ? ' ' + e.url.slice(0, 80) : ''}`; }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch { /* unsupported engine */ }
      });
      // test hook for the chunk-retry path: SIMULATE_CHUNK_FAIL=once (fails pass 1 only) | always (recurs on the retry)
      if (process.env.SIMULATE_CHUNK_FAIL && (process.env.SIMULATE_CHUNK_FAIL === 'always' || pass === 1)) {
        let done = false;
        await page.route(/\/_next\/static\/chunks\/[^?]+\.js(\?|$)/, route => { if (done) return route.continue(); done = true; return route.abort('failed'); });
      }
      const consoleErrors = [], failed = [], chunkFails = []; let ignoredAborted = 0;
      page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url || '')) consoleErrors.push(m.text().slice(0, 160)); });
      page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) { const s = `${r.status()} ${r.url().slice(0, 120)}`; failed.push(s); if (isChunkUrl(r.url())) chunkFails.push(s); } });
      page.on('requestfailed', r => {
        const err = r.failure()?.errorText || '';
        if (err === 'net::ERR_ABORTED' && IGNORE_ABORTED.some(re => re.test(r.url()))) { ignoredAborted++; return; }
        const s = `FAILED ${err} ${r.url().slice(0, 120)}`; failed.push(s);
        // an aborted chunk is the fallback goto cancelling in-flight requests, not a missing asset: no retry for it
        if (isChunkUrl(r.url()) && err !== 'net::ERR_ABORTED') chunkFails.push(s);
      });
      const t0 = Date.now(); let status = 0;
      try {
        const resp = await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60000 });
        status = resp ? resp.status() : 0;
      } catch (e) {
        consoleErrors.push('goto: ' + e.message.slice(0, 120));
        try { const resp = await page.goto(entry.url, { waitUntil: 'load', timeout: 60000 }); status = resp ? resp.status() : 0; } catch {}
      }
      const loadMs = Date.now() - t0;
      // LCP: short settle for the observer callback, read BEFORE the autoscroll — programmatic scrolling does not stop LCP
      // reporting, so lazy content painted into the viewport during the scroll would otherwise register as a later "LCP"
      await page.waitForTimeout(400);
      const lcp = await page.evaluate(() => ({ ms: typeof window.__lcp === 'number' ? Math.round(window.__lcp) : null, el: window.__lcpEl || null })).catch(() => ({ ms: null, el: null }));
      // trigger lazy content, then return to top
      const autoscroll = () => page.evaluate(async () => { await new Promise(res => { let y = 0; const step = () => { window.scrollBy(0, 700); y += 700; if (y < document.body.scrollHeight + 700) setTimeout(step, 90); else { window.scrollTo(0, 0); setTimeout(res, 350); } }; step(); }); });
      let m;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await autoscroll();
          await page.waitForTimeout(600);
          m = await page.evaluate(pageMetrics, { ctaPatterns: cfg.ctaPatterns, vw: v.width, bannedPhrases: BANNED, allowPhrases: ALLOW });
          break;
        } catch (e) { // client-side navigation/redirect mid-measure: wait and retry once
          consoleErrors.push('measure: ' + e.message.slice(0, 100));
          await page.waitForLoadState('load').catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
      if (!m) m = { title: '', metaDescLen: 0, canonical: '', robots: '', ogImage: false, h1s: [], h2s: [], words: 0, cta: {}, suspiciousLinks: [], internalLinks: [], externalLinkCount: 0, overflow: false, overflowEls: [], imgCount: 0, noAlt: 0, oversized: [], brokenImgs: [], fixed: [], smallTap: 0, interactive: 0, forms: 0, inputs: 0, foldText: [], docH: 0, ttfbMs: null, domContentLoadedMs: null, bannedHits: [] };
      m.internalLinks.forEach(h => allInternal.add(h));

      let axe = null;
      // real responses only: status 0 (goto failed) would scan Chromium's error page and pollute the sitewide denominator
      if (AxeBuilder && cfg.axe?.enabled && vname === 'desktop' && status >= 200 && status < 400) {
        try {
          const r = await new AxeBuilder({ page }).withTags(cfg.axe.tags || ['wcag2a', 'wcag2aa']).analyze();
          // one item per failing node; (rule, target) is the key the sitewide pass after the page loop dedupes on
          const items = r.violations.flatMap(vi => vi.nodes.map(n => ({
            rule: vi.id, impact: vi.impact || 'minor', help: vi.help,
            target: Array.isArray(n.target) ? n.target.flat(Infinity).join(' ') : String(n.target),
            data: (n.any?.[0] || n.all?.[0] || n.none?.[0] || {}).data ?? null,
            html: (n.html || '').slice(0, 160),
          })));
          axe = { violations: r.violations.length, nodes: items.length, ...summarizeAxe(items), items };   // page-only numbers substituted after the loop
        } catch (e) { axe = { error: e.message.slice(0, 120) }; }
      }

      const foldPng = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: v.width, height: v.height } });
      const fullPng = await page.screenshot({ type: 'png', fullPage: true });
      await toJpeg(foldPng, path.join(dir, `${vname}_fold.jpg`), 74);
      await toJpeg(fullPng, path.join(dir, `${vname}_full.jpg`), 62);

      const diff = await diffImages(path.join(dir, `${vname}_full.jpg`), path.join(PREV, 'pages', slug, `${vname}_full.jpg`), path.join(dir, `${vname}_diff.jpg`), v.mobile ? 390 : 720);

      // chunkFailures non-empty on the final view <=> the failure recurred on the retry; retried + empty <=> transient
      const chunkFailures = [...new Set(chunkFails)].slice(0, 4);
      entry.views[vname] = { status, loadMs, consoleErrors: consoleErrors.slice(0, 6), failedRequests: [...new Set(failed)].slice(0, 8), ignoredAbortedRequests: ignoredAborted,
        retried: pass > 1, chunkFailures, firstAttemptChunkFailures, ...m, lcpMs: lcp.ms, lcpEl: lcp.el, axe, diff };
      log(`${p} ${vname} ${status} ${loadMs}ms lcp=${lcp.ms ?? '–'} h=${m.docH} words=${m.words}${m.overflow ? ' OVERFLOW' : ''}${diff ? ` diff=${diff.pctChanged}%` : ''}${chunkFailures.length ? ` CHUNK-FAIL${pass > 1 ? ' (recurred)' : ''}` : ''}`);
      await context.close();
      if (chunkFailures.length && pass === 1) { firstAttemptChunkFailures = chunkFailures; log(`${p} ${vname}: first-party /_next/static failure — retrying once in a fresh context`); continue; }
      break;
    }
  }

  // composites for Claude: fold (desktop | mobile) and top-of-page (desktop@800 | mobile@400)
  const d = entry.views.desktop, mo = entry.views.mobile;
  try {
    const foldA = await fs.readFile(path.join(dir, 'desktop_fold.jpg'));
    const foldB = await sharp(path.join(dir, 'mobile_fold.jpg')).resize({ width: cfg.viewports.mobile.width }).toBuffer();
    await sideBySide(foldA, foldB, path.join(dir, 'fold.jpg'));
    const fullA = await topCrop(path.join(dir, 'desktop_full.jpg'), cfg.composites.desktopFullWidth, cfg.composites.fullTopPx);
    const fullB = await topCrop(path.join(dir, 'mobile_full.jpg'), cfg.composites.mobileFullWidth, cfg.composites.fullTopPx);
    await sideBySide(fullA, fullB, path.join(dir, 'full.jpg'));
  } catch (e) { entry.flags.push('composite failed: ' + e.message.slice(0, 80)); }

  // ---- flags (what a human should look at)
  const f = entry.flags;
  const isExpected404 = /404|does-not-exist/.test(p);
  const banned = new Map();   // phrase -> { phrase, count, snippet, views[] } merged across viewports (responsive copy differs)
  for (const [vn, vw] of Object.entries(entry.views)) {
    if (vw.status >= 400 && !isExpected404) f.push(`HTTP ${vw.status} (${vn})`);
    if (vw.loadMs > T.loadMsWarn) f.push(`slow load ${vw.loadMs}ms (${vn})`);
    if (T.lcpMsWarn && vw.lcpMs > T.lcpMsWarn) f.push(`slow LCP ${vw.lcpMs}ms (${vn}${vw.lcpEl ? ', ' + vw.lcpEl : ''})`);
    if (vw.overflow) f.push(`horizontal overflow on ${vn}: ${vw.overflowEls.join(', ')}`);
    // first-party chunk failures have their own flag below (only when they recurred on the retry), so keep them out of the generic lists
    const realFails = vw.failedRequests.filter(x => !(isExpected404 && x.includes(p)) && !x.includes(BASE + '/_next/static/'));
    if (realFails.length) f.push(`failed resources (${vn}): ${realFails.slice(0, 3).join(' · ')}`);
    if (vw.chunkFailures?.length) f.push(`chunk 404 — possible deploy skew (${vn}, recurred on retry): ${vw.chunkFailures.slice(0, 2).join(' · ')}`);
    const consoleReal = vw.consoleErrors.filter(x => !(x.startsWith('Failed to load resource') && (isExpected404 || vw.chunkFailures?.length)));
    if (consoleReal.length && !isExpected404) f.push(`console errors (${vn}): ${consoleReal.slice(0, 2).join(' · ')}`);
    if (vw.suspiciousLinks.length) f.push(`suspicious hrefs (${vn}): ${vw.suspiciousLinks.map(s => JSON.stringify(s.href)).slice(0, 3).join(', ')}`);
    if (vw.brokenImgs.length) f.push(`broken images (${vn}): ${vw.brokenImgs.length}`);
    if (vw.diff && vw.diff.pctChanged >= T.diffPctWarn) f.push(`changed ${vw.diff.pctChanged}% vs previous (${vn})`);
    if (vw.diff && Math.abs(vw.diff.heightChange) >= T.heightChangeWarn) f.push(`page height ${vw.diff.heightChange > 0 ? '+' : ''}${Math.round(vw.diff.heightChange * 100)}% vs previous (${vn})`);
    for (const h of vw.bannedHits || []) { const b = banned.get(h.phrase) || { ...h, views: [] }; b.views.push(vn); banned.set(h.phrase, b); }
  }
  for (const b of banned.values()) f.push(`banned phrase "${b.phrase}" ×${b.count} (${b.views.join(', ')}): “…${b.snippet}…”`);
  if (d) {
    if (d.h1s.length !== 1 && !isExpected404) f.push(`${d.h1s.length} H1s`);
    if ((d.metaDescLen < 70 || d.metaDescLen > 165) && !isExpected404) f.push(`meta description ${d.metaDescLen} chars`);
    if (d.oversized.length) f.push(`oversized images: ${d.oversized.slice(0, 2).join(' · ')}`);
    if (d.noAlt) f.push(`${d.noAlt} images without alt`);
    if (d.words < T.minWordsWarn && !isExpected404) f.push(`thin page: ${d.words} words`);
    if (!d.cta.contact && !d.cta.booking && !isExpected404) f.push('no contact or booking CTA found');
    // the a11y flag is pushed after the page loop, once sitewide (template) nodes are known — see "sitewide a11y dedupe"
  }
  results.push(entry);
}
await browser.close();

// ---------------------------------------------------------------- sitewide a11y dedupe
// A (rule, selector) pair that fails on >= SITEWIDE_SHARE of the scanned pages is a layout issue (header/footer/nav or
// a shared component): report it once under "Sitewide" and take it out of every page's a11y line and counts.
const { sitewideA11y, axePagesScanned } = dedupeSitewideA11y(results, SITEWIDE_SHARE);
log(`a11y: ${sitewideA11y.length} sitewide issue(s) on >=${Math.round(SITEWIDE_SHARE * 100)}% of ${axePagesScanned} scanned pages`);

// ---------------------------------------------------------------- internal link check
let linkReport = null;
if (cfg.linkCheck?.enabled) {
  const links = [...allInternal].filter(h => !/\.(pdf|jpg|png|svg|webp|zip)$/i.test(h)).slice(0, cfg.linkCheck.maxLinks);
  const broken = []; let checked = 0;
  const queue = [...links];
  const worker = async () => { while (queue.length) { const h = queue.shift(); checked++; try { const r = await fetch(BASE + h, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'rma-site-snapshots/1.0' } }); if (r.status >= 400) broken.push({ href: h, status: r.status }); } catch (e) { broken.push({ href: h, status: 'ERR ' + e.message.slice(0, 40) }); } } };
  await Promise.all(Array.from({ length: cfg.linkCheck.concurrency || 6 }, worker));
  linkReport = { checked, broken };
  log(`link check: ${checked} internal links, ${broken.length} broken`);
}

// ---------------------------------------------------------------- previous manifest (new / removed pages)
let prevManifest = null;
try { prevManifest = JSON.parse(await fs.readFile(path.join(PREV, 'manifest.json'), 'utf8')); } catch {}
const prevPaths = new Set((prevManifest?.pages || []).map(x => x.path));
const curPaths = new Set(results.map(x => x.path));
const newPages = [...curPaths].filter(x => !prevPaths.has(x));
const removedPages = [...prevPaths].filter(x => !curPaths.has(x));

// ---------------------------------------------------------------- manifest
const alerts = results.filter(r => r.flags.length).map(r => ({ path: r.path, slug: r.slug, flags: r.flags }));
const changed = results.filter(r => Object.values(r.views).some(v => v.diff && v.diff.pctChanged >= T.diffPctWarn)).map(r => r.path);
const manifest = {
  generatedAt: startedAt.toISOString(), baseUrl: BASE, durationSec: Math.round((Date.now() - startedAt) / 1000),
  previousRun: prevManifest?.generatedAt || null,
  summary: { pages: results.length, pagesWithFlags: alerts.length, changedPages: changed, newPages, removedPages,
    brokenInternalLinks: linkReport?.broken.length ?? null, linksChecked: linkReport?.checked ?? null,
    sitewideA11yIssues: sitewideA11y.length, axePagesScanned,
    bannedPhrasePages: results.filter(r => Object.values(r.views).some(v => v.bannedHits?.length)).map(r => r.path),
    retriedViews: results.flatMap(r => Object.entries(r.views).filter(([, v]) => v.retried).map(([vn]) => `${r.path} (${vn})`)),
    chunkSkewViews: results.flatMap(r => Object.entries(r.views).filter(([, v]) => v.chunkFailures?.length).map(([vn]) => `${r.path} (${vn})`)) },
  howToRead: 'Start with summary + alerts, then sitewideA11y (template-level axe failures, reported once and excluded from per-page a11y counts; the totals stay in views.desktop.axe.totalByImpact). For each page: pages/<slug>/fold.jpg = desktop|mobile above the fold; pages/<slug>/full.jpg = top 3000px of desktop|mobile full page; *_diff.jpg exists only when the page changed vs the previous run. views.*.lcpMs is Largest Contentful Paint in ms (lcpEl = the element); views.*.bannedHits lists banned copy found (phrase, count, snippet); views.*.retried means a first-party /_next/static failure was retried once in a fresh context (chunkFailures non-empty = it recurred, see summary.chunkSkewViews).',
  alerts, sitewideA11y, linkCheck: linkReport,
  pages: results.map(r => ({ path: r.path, slug: r.slug, url: r.url, flags: r.flags,
    files: { fold: `pages/${r.slug}/fold.jpg`, full: `pages/${r.slug}/full.jpg`, desktopFold: `pages/${r.slug}/desktop_fold.jpg`, mobileFold: `pages/${r.slug}/mobile_fold.jpg`, desktopFull: `pages/${r.slug}/desktop_full.jpg`, mobileFull: `pages/${r.slug}/mobile_full.jpg`,
      desktopDiff: r.views.desktop?.diff?.diffFile ? `pages/${r.slug}/${r.views.desktop.diff.diffFile}` : null, mobileDiff: r.views.mobile?.diff?.diffFile ? `pages/${r.slug}/${r.views.mobile.diff.diffFile}` : null },
    views: r.views })),
};
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

// ---------------------------------------------------------------- report.md
const d8 = startedAt.toISOString().slice(0, 10);
let md = `# Site snapshot — ${d8}\n\n`;
md += `Base: ${BASE} · ${results.length} pages · ${manifest.durationSec}s · previous run: ${manifest.previousRun ? manifest.previousRun.slice(0, 10) : 'none'}\n\n`;
md += `## Alerts (${alerts.length} pages)\n\n`;
md += alerts.length ? alerts.map(a => `- **${a.path}**\n${a.flags.map(f => `  - ${f}`).join('\n')}`).join('\n') + '\n' : '- none\n';
md += `\n## Sitewide accessibility (same element on ≥${Math.round(SITEWIDE_SHARE * 100)}% of ${axePagesScanned} pages — fix once in the layout; excluded from per-page counts)\n\n`;
md += sitewideA11y.length ? sitewideA11y.map(s => `- **${s.rule}** (${s.impact}) on ${s.pageCount}/${s.pagesScanned} pages — \`${s.target}\`${s.data?.contrastRatio ? ` — contrast ${s.data.contrastRatio} (needs ${s.data.expectedContrastRatio}) ${s.data.fgColor} on ${s.data.bgColor}` : ''}${s.missingFrom.length ? ` — not on: ${s.missingFrom.join(', ')}` : ''}`).join('\n') + '\n' : '- none\n';
md += `\n## Changes vs previous run\n\n`;
md += changed.length ? `- Visually changed (≥${T.diffPctWarn}%): ${changed.join(', ')}\n` : '- No page changed more than the threshold\n';
if (newPages.length) md += `- New pages: ${newPages.join(', ')}\n`;
if (removedPages.length) md += `- Removed pages: ${removedPages.join(', ')}\n`;
if (linkReport) { md += `\n## Internal links\n\n${linkReport.checked} checked, ${linkReport.broken.length} broken\n`; if (linkReport.broken.length) md += linkReport.broken.map(b => `- ${b.status} ${b.href}`).join('\n') + '\n'; }
md += `\n## All pages\n\n| Page | Status | Load d/m (ms) | LCP d/m | Words | H1 | CTA contact/book/guide/RC | Forms | a11y crit/ser | Diff d/m |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of results) { const d = r.views.desktop || {}, m = r.views.mobile || {}; const ax = d.axe?.byImpact || {}; md += `| ${r.path} | ${d.status}/${m.status} | ${d.loadMs}/${m.loadMs} | ${d.lcpMs ?? '–'}/${m.lcpMs ?? '–'} | ${d.words} | ${(d.h1s || [])[0]?.slice(0, 50) || '–'} | ${d.cta?.contact}/${d.cta?.booking}/${d.cta?.inventors}/${d.cta?.realityCheck} | ${d.forms} | ${ax.critical || 0}/${ax.serious || 0} | ${d.diff ? d.diff.pctChanged + '%' : '–'}/${m.diff ? m.diff.pctChanged + '%' : '–'} |\n`; }
await fs.writeFile(path.join(OUT, 'report.md'), md);

// ---------------------------------------------------------------- gallery
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const card = r => { const d = r.views.desktop || {}, m = r.views.mobile || {}; const dd = r.views.desktop?.diff, md2 = r.views.mobile?.diff; return `
<section class="card${r.flags.length ? ' flagged' : ''}" id="${esc(r.slug)}">
 <h2><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.path)}</a> <small>${esc(d.title || '')}</small></h2>
 <div class="meta">HTTP ${d.status}/${m.status} · load ${d.loadMs}/${m.loadMs} ms · LCP ${d.lcpMs ?? '–'}/${m.lcpMs ?? '–'} ms · ${d.words} words · ${d.h1s?.length} H1${d.axe?.byImpact ? ` · a11y ${d.axe.byImpact.critical || 0}/${d.axe.byImpact.serious || 0}` : ''}${dd ? ` · diff ${dd.pctChanged}% / ${md2?.pctChanged ?? '–'}%` : ''}</div>
 ${r.flags.length ? `<ul class="flags">${r.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
 <a href="pages/${r.slug}/fold.jpg"><img loading="lazy" src="pages/${r.slug}/fold.jpg" alt="${esc(r.path)} above the fold, desktop and mobile"></a>
 <div class="links"><a href="pages/${r.slug}/desktop_full.jpg">desktop full</a><a href="pages/${r.slug}/mobile_full.jpg">mobile full</a><a href="pages/${r.slug}/full.jpg">top-of-page pair</a>${dd?.diffFile ? `<a href="pages/${r.slug}/${dd.diffFile}">desktop diff</a>` : ''}${md2?.diffFile ? `<a href="pages/${r.slug}/${md2.diffFile}">mobile diff</a>` : ''}</div>
</section>`; };
const sorted = [...results].sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RMA site snapshot ${d8}</title>
<style>:root{color-scheme:dark}body{font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#0f1115;color:#e6e8ee}h1{font-size:20px;margin:0 0 4px}.sum{color:#9aa3b2;margin-bottom:18px}.sum a{color:#8ab4ff}
.card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:14px;margin:0 0 16px}.card.flagged{border-color:#b7791f}h2{font-size:16px;margin:0 0 6px;word-break:break-all}h2 a{color:#e6e8ee;text-decoration:none}h2 small{display:block;color:#9aa3b2;font-weight:400;font-size:13px}
.meta{color:#9aa3b2;font-size:13px;margin-bottom:8px}.flags{margin:0 0 10px;padding-left:18px;color:#f6c177;font-size:13px}.card.sitewide{border-color:#5b8def}.card.sitewide .flags{color:#c3d4ff}code{font-size:12px;color:#c9d1d9}img{width:100%;height:auto;border-radius:8px;border:1px solid #262b36;background:#fff}.links{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:8px;font-size:13px}.links a{color:#8ab4ff}</style></head><body>
<h1>rma-engineering.com — snapshot ${d8}</h1>
<div class="sum">${results.length} pages · ${alerts.length} flagged · ${changed.length} changed vs previous${linkReport ? ` · ${linkReport.broken.length} broken internal links` : ''} · ${sitewideA11y.length} sitewide a11y · <a href="report.md">report.md</a> · <a href="manifest.json">manifest.json</a><br>Flagged pages are listed first. Each image shows desktop (1440) and mobile (390) above the fold.</div>
${sitewideA11y.length ? `<section class="card sitewide"><h2>Sitewide accessibility <small>same element on ≥${Math.round(SITEWIDE_SHARE * 100)}% of ${axePagesScanned} pages — fix once in the layout; not repeated on the page cards below</small></h2><ul class="flags">${sitewideA11y.map(s => `<li><b>${esc(s.rule)}</b> (${esc(s.impact)}) on ${s.pageCount}/${s.pagesScanned} pages — <code>${esc(s.target)}</code>${s.data?.contrastRatio ? ` — contrast ${esc(s.data.contrastRatio)} (needs ${esc(s.data.expectedContrastRatio)})` : ''}${s.missingFrom.length ? ` — not on: ${esc(s.missingFrom.join(', '))}` : ''}</li>`).join('')}</ul></section>` : ''}
${sorted.map(card).join('\n')}
</body></html>`;
await fs.writeFile(path.join(OUT, 'index.html'), html);
log(`done: ${results.length} pages, ${alerts.length} flagged, ${changed.length} changed, ${manifest.durationSec}s`);
