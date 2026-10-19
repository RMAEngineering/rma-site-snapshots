# rma-site-snapshots

Scheduled visual + structural QA for **rma-engineering.com**. Every run renders each sitemap page at desktop (1440) and mobile (390), then checks it, diffs it against the last run, and publishes:

- a phone-friendly **gallery** you can flip through (GitHub Pages)
- a **report.md** with alerts at the top
- a **manifest.json** + side-by-side composites that Claude reads directly from GitHub

Runs every Monday 7am ET, on demand with one click, and (optional) automatically after every production deploy.

## What each run checks

| Area | What it catches |
|---|---|
| Rendering | HTTP status, load time, console errors, failed requests, broken images |
| Speed | Largest Contentful Paint per viewport (PerformanceObserver, with the element), flagged above `lcpMsWarn` |
| Mobile | horizontal overflow (and which element), tap targets, fixed/sticky bars |
| Content/SEO | H1 count, meta description length, canonical, robots, thin pages, word count |
| CTAs | counts of contact / booking / guide / Reality Check / phone links per page |
| Links | every internal link on the site fetched; 404s listed; suspicious hrefs (`#`, `&`, empty) |
| Images | oversized images (served at >2× display width), missing alt |
| Accessibility | axe-core WCAG 2.0/2.1 A+AA scan per page (critical/serious counts, top rules) |
| Sitewide a11y | an axe (rule, selector) pair failing on ≥50% of scanned pages is listed once under "Sitewide" and removed from the per-page counts and flags |
| Copy | `bannedPhrases` (e.g. "10+ years", "12 hours", the old info@ email, "A+") found in a page's visible text, with the matching snippet; `allowPhrases` carve out legitimate uses |
| Font | the body's computed `font-family` per viewport (`views.<v>.fontFamily`, raw in the gallery meta line); flagged "font: body font-family starts with 'X', expected 'Inter'" when the first family, normalized, does not start with `expectedFont` (the Oct 19 Times New Roman incident) |
| Change | pixel diff vs previous run (% changed, page height change), new/removed pages |
| Sitewide change | when ≥80% of the compared pages changed ≥`diffPctWarn`, one "sitewide change" line (`summary.sitewideChange`) replaces the per-page "changed" flags; diff numbers, diff images and "page height" flags stay |
| Deploy skew | a failed first-party `/_next/static` chunk (404 or network error) is retried once in a fresh browser context; flagged "chunk 404 — possible deploy skew" only if it recurs, otherwise just recorded (`retried`, `summary.retriedViews`) |

## One-time setup (≈10 minutes)

1. **Create a public repo** called `rma-site-snapshots` in the RMAEngineering org (same org as RMA-Engineering-Website) (public so Claude can read the results without a token — it only ever contains screenshots of the public site).
2. **Push these files** to `main` (drag-and-drop in the GitHub UI works, or `gh repo create rma-site-snapshots --public --source=. --push`).
3. **Run it once:** Actions → *Site snapshot* → *Run workflow*. First run takes ~5 minutes.
4. **Turn on the gallery:** Settings → Pages → Source: *Deploy from a branch* → Branch: `snapshots`, folder `/ (root)` → Save. (The `snapshots` branch only exists after the first run.)
5. Open `https://RMAEngineering.github.io/rma-site-snapshots/` on your phone. Bookmark it.
6. Add `docs/CLAUDE_VISUAL_REVIEW_PROTOCOL.md` to the Claude Project knowledge.

## After a major site update

Either click **Run workflow** (Actions → Site snapshot), or type in a Project chat: *"Run the visual review"* — Claude will read the latest run and tell you if it needs a fresh one.

Optional: limit a run to a few pages with the `pages` input, e.g. `/,/contact-us,/inventors`. Note that a limited run on `main` still replaces the live gallery with that partial page set; runs on any other branch (`gh workflow run snapshot.yml --ref <branch> -f pages=...`) skip the publish step and only produce the Actions artifact.

## Optional: run automatically after every production deploy

Copy `site-repo/trigger-snapshots.yml` into the site repo at `.github/workflows/`, create a fine-grained PAT scoped to this repo (Contents: read/write), store it in the site repo as the secret `SNAPSHOT_TRIGGER_TOKEN`. Vercel's GitHub integration marks production deployments as environment `Production`; the trigger waits 3 minutes for the CDN, then starts a run.

## Where things live

| Thing | Location |
|---|---|
| Gallery (humans) | `https://RMAEngineering.github.io/rma-site-snapshots/latest/` |
| Report | `.../latest/report.md` |
| Manifest (Claude) | `https://raw.githubusercontent.com/RMAEngineering/rma-site-snapshots/snapshots/latest/manifest.json` |
| Composites (Claude) | `.../snapshots/latest/pages/<slug>/fold.jpg` and `full.jpg` |
| 90-day archive | Actions → the run → Artifacts (`snapshot-<run id>.zip`) |

The `snapshots` branch is rewritten from scratch on every run (orphan commit, force-pushed), so the repo stays ~40 MB regardless of how many weeks it runs. Older runs live in the Actions artifacts for 90 days.

## Tuning

Everything is in `pages.config.json`: which pages (sitemap + extras, exclusions, how many blog posts), viewports, thresholds for flags (`loadMsWarn`, `lcpMsWarn`, `diffPctWarn`, `sitewideChangeShare`, `heightChangeWarn`, `minWordsWarn`), CTA patterns, link-check limits, axe tags, `bannedPhrases` / `allowPhrases`, `axe.sitewideShare`, `expectedFont`. No code changes needed for normal adjustments.

`thresholds.sitewideChangeShare` (default 0.8) is the rollup rule for visual changes. A page is *compared* when it has a diff against the previous run on at least one viewport, and *changed* when either viewport moved by ≥ `diffPctWarn`. When changed ÷ compared ≥ `sitewideChangeShare`, the change is one layout/template edit (header, footer, font, banner), not N page edits: the run reports it **once** — `summary.sitewideChange = { pages, compared, share, desktopAvgPct, mobileAvgPct }` in the manifest (the averages are the mean `pctChanged` over the compared views per viewport), one line under "Changes vs previous run" in report.md, a blue card at the top of the gallery — and removes the per-page `changed X% vs previous` flags. Each view's `diff` numbers, the `*_diff.jpg` images and the `page height ±N%` flags are kept, and `summary.changedPages` still lists every page. Below the share every page keeps its own "changed" flag, as before. At least 2 compared pages are required (a one-page run cannot make a sitewide claim).

`expectedFont` (default `"Inter"`) is what the body's computed `font-family` must start with. Each view records `getComputedStyle(document.body).fontFamily` as `views.<v>.fontFamily` (raw, e.g. `"__Inter_d8ebd1", "__Inter_Fallback_d8ebd1", system-ui, ...`). Only the **first** family in that list is compared, after normalization: surrounding quotes, a leading `__` and a trailing `_<6 hex>` are stripped, because next/font renders the family as `__Inter_d8ebd1`; so `"__Inter_d8ebd1"` → `Inter`, which starts with `Inter` (case-insensitive) → no flag. When the first family is anything else the page gets one flag per offending family with the viewports that show it: `font: body font-family starts with 'Times New Roman', expected 'Inter' (desktop, mobile)` — exactly what the Oct 19 outage looked like, when a stale font class left `--font-inter` undefined for 30 minutes. `summary.fontMismatchPages` lists the pages, `summary.expectedFont` echoes the value in force. Set `expectedFont` to `""` to disable the check. The normalization lives in `scripts/checks.mjs` (`firstFontFamily`) and is unit-tested.

`ignoreAbortedRequests` lists URL patterns whose `net::ERR_ABORTED` failures are not flagged: Google Ads/GA beacons, Meta Pixel, HubSpot tracking, Vercel Analytics and Next.js `_rsc` prefetches. Browsers cancel these routinely when a page moves on, so they say nothing about the site. Only *aborted* requests are skipped. A 4xx/5xx or any other network error on the same URLs is still flagged. The per-view count of skipped requests is in the manifest as `ignoredAbortedRequests`.

`bannedPhrases` is copy that must never appear on the site (stale claims, the retired info@ address, the wrong BBB grade). Each page's visible text (`document.body.innerText`, so hidden drawers and JSON-LD are excluded) is checked case-insensitively at both viewports; a hit produces one flag per phrase with the count and a snippet, and the page is listed in `summary.bannedPhrasePages`. `allowPhrases` are legitimate uses: a banned match is ignored when an allow phrase appears within 40 characters of it — e.g. `"12-hour time zone"` keeps the tariffs post's "12-hour time zone gap" from tripping `"12-hour"`. For a one-off test, `BANNED_PHRASES_EXTRA="since 2020"` adds phrases for that run only.

`axe.sitewideShare` (default 0.5) is the share of scanned pages on which the same axe (rule, selector) pair must fail to count as sitewide. Sitewide items appear once (manifest `sitewideA11y`, the "Sitewide accessibility" section of report.md, the blue card at the top of the gallery) and are removed from every page's a11y counts and flag; the untouched totals stay in `views.desktop.axe.totalByImpact` / `sitewideNodes`. A pair must also be on at least 2 pages (sitewide means repeated), so a one- or two-page run cannot promote a node seen once.

## Running locally

```bash
npm install
npx playwright install chromium
npm run snapshot            # writes out/latest/index.html
MSYS_NO_PATHCONV=1 ONLY_PAGES=/,/contact-us OUT_DIR=out/test node scripts/snapshot.mjs   # subset (same as the workflow's "pages" input); Git Bash on Windows converts a leading "/" to C:/Program Files/Git/ without MSYS_NO_PATHCONV
```

PowerShell: `$env:ONLY_PAGES='/,/contact-us'; $env:OUT_DIR='out/test'; node scripts/snapshot.mjs` (the `VAR=x cmd` form in `npm run snapshot:local` only works in a POSIX shell).

Set `PREV_DIR=path/to/previous/latest` to get diffs locally. `CHROMIUM_PATH` can point at an installed Chrome instead of Playwright's pinned Chromium, but rendering (and so pixel diffs) may then differ from CI.

Test hooks, inert unless set: `BANNED_PHRASES_EXTRA="since 2020"` adds banned phrases for one run (positive test of the copy check); `SIMULATE_CHUNK_FAIL=once` fails the first `/_next/static/chunks` request on the first pass only (expect `retried: true`, no flag), `=always` makes it recur (expect the "chunk 404" flag); `EXPECTED_FONT=Georgia` overrides `expectedFont` for one run (expect every page flagged `font: body font-family starts with 'Inter', expected 'Georgia' (desktop, mobile)`); `SIMULATE_CHANGED=1` marks every view as changed (`pctChanged` forced to 100, `diff.simulated: true`; a diff is fabricated when there is no previous run) — with ≥2 pages expect `summary.sitewideChange` and no per-page "changed" flags.

Unit tests for the pure helpers (`scripts/checks.mjs`, no browser): `npm test`.

## Cost

$0. Public-repo GitHub Actions minutes are free; each run uses ~5 minutes.
