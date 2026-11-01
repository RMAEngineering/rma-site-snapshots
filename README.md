# rma-site-snapshots

Scheduled visual + structural QA for **rma-engineering.com**. Every run renders each sitemap page at desktop (1440) and mobile (390), then checks it, diffs it against the last run, and publishes:

- a phone-friendly **gallery** you can flip through (GitHub Pages)
- a **report.md** with alerts at the top
- a **manifest.json** + side-by-side composites that Claude reads directly from GitHub
- a phone-readable **traffic.md** (+ `traffic.json`): 8 weeks of US traffic from Vercel Web Analytics, GA4 sessions by source and 16 weeks of Search Console, with flags, refreshed on the Monday run

Runs every Monday 7am ET, on demand with one click, and (optional) automatically after every production deploy.

## What each run checks

| Area | What it catches |
|---|---|
| Rendering | HTTP status, load time, console errors, failed requests (minus the `ignoreAbortedRequests` / `ignoreFailedRequests` carve-outs), broken images |
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
7. **Traffic report:** add the repo secret `VERCEL_TOKEN` (Settings → Secrets and variables → Actions): a Vercel account token that can read Web Analytics for the site project (ids in `traffic.config.json`). Without it the Monday run still publishes; `traffic.md` just carries a `DATA_GAP` flag.
8. **Google sources (optional):** on a laptop that has the gsc-inspect OAuth client JSON, run `node scripts/google-auth-once.mjs` once (see *Google auth* below), then add the repo secrets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` and `GA4_PROPERTY_ID`. Until they exist, traffic.md says `GA4 not configured` / `Search Console not configured` and nothing else changes.

## After a major site update

Either click **Run workflow** (Actions → Site snapshot), or type in a Project chat: *"Run the visual review"* — Claude will read the latest run and tell you if it needs a fresh one.

Optional: limit a run to a few pages with the `pages` input, e.g. `/,/contact-us,/inventors`. Note that a limited run on `main` still replaces the live gallery with that partial page set; runs on any other branch (`gh workflow run snapshot.yml --ref <branch> -f pages=...`) skip the publish step and only produce the Actions artifact.

## Optional: run automatically after every production deploy

Copy `site-repo/trigger-snapshots.yml` into the site repo at `.github/workflows/`, create a fine-grained PAT scoped to this repo (Contents: read/write), store it in the site repo as the secret `SNAPSHOT_TRIGGER_TOKEN`. Vercel's GitHub integration marks production deployments as environment `Production`; the trigger waits 3 minutes for the CDN, then starts a run.

## Weekly traffic report (traffic.md)

`latest/traffic.md` is a phone-readable page of the **8 most recent complete Monday–Sunday weeks** (UTC; never the week in progress) from Vercel Web Analytics, plus GA4 and Search Console when their secrets exist (below), next to `latest/traffic.json` with the same numbers machine-readable (`generatedAt`, `window`, `sources`, `flags[]`, `weeks[]` oldest first). Per week, filtered to the US: visitors and pageviews; visitors and pageviews by referrer (`""` = no referrer — direct, apps and most ChatGPT clicks — plus google.com, chatgpt.com, bing.com, linkedin.com, duckduckgo.com; everything else is `other`); visitors per page (`pages`) and per page group (`adPages` = /contact-us + /inventors, `deepPages` = /our-approach, /reality-check, /about-us, /services and children, /industries and children, /faq, `thankYou`, `blog`, `metro` = the `*-product-development` and nyc-prototype-development landing pages); the pages chatgpt.com sent US visitors to (`chatgptPages`); and, across **all** countries, the non-US share of no-referrer visitors (`botShareNoReferrer` — Singapore/China one-pageview sessions with no referrer are bots). Visitors are unique per Vercel row, so a group total or the per-path ChatGPT list adds up per-page uniques and can exceed the referrer-level count; pageviews add exactly. The table's ChatGPT column is the referrer-level count.

**When it refreshes.** The Monday schedule run and a plain *Run workflow* (empty `pages` box) query Vercel (5 calls) and rewrite `latest/traffic.*` plus `history/traffic/<weekStart>.json`. A post-deploy run (`repository_dispatch`) or a page-limited manual run does not query; it copies the previous `latest/traffic.*` forward unchanged. `history/traffic/` is copied forward on **every** run, because the `snapshots` branch is rebuilt from scratch each time and anything not copied is gone. The newest week's history file is rewritten on each refresh; older weeks in the window are written only when missing, so the first run backfills 8 files. History is not written when any query failed.

**Flags** (newest complete week vs the average of the 4 weeks before it; every threshold lives in `traffic.config.json`, none in code): `US_NOREF_DOWN` (US no-referrer visitors ≤ 75% of avg), `DEEP_PAGES_DOWN` (≤ 60%), `AD_PAGES_DOWN` (≤ 60%), `TRAFFIC_UP` (US visitors ≥ 140%), `CHATGPT_ZERO` (Vercel: chatgpt.com referrer = 0 for 2 weeks in a row while the 8-week max is ≥ 3 — evaluated only while `sources.ga4` is not `ok`; with GA4 ok, `CHATGPT_DOWN` is the ChatGPT flag, because Vercel misses the app clicks that arrive with `utm_source=chatgpt.com` and no referrer), `BOT_SPIKE` (non-US share of no-referrer visitors ≥ 1.4× the prior 4-week average, or ≥ 0.7 outright — the normal share here is 0.45–0.57 every week, so only a jump counts), `BRAND_IMPR_DOWN` (Search Console brand impressions ≤ 50% of avg), `ORGANIC_DOWN` (GA4 google/organic sessions ≤ 60% of avg, only when the avg is ≥ 10), `CHATGPT_DOWN` (GA4 chatgpt.com/referral sessions ≤ 50% of avg, only when the avg is ≥ 4), `EVENT_DROP` (one flag per event among `form_submit`, `booking_confirmed`, `generate_lead` whose newest week is ≤ 40% of a prior 4-week average of at least 3), `GSC_IMPR_DOWN` (Search Console impressions ≤ 70% of avg), `GA4_VS_VERCEL_GAP` (GA4 US sessions and Vercel US visitors for the newest week differ by more than 50% of the larger one — symmetric, so it does not matter which side is high), `DATA_GAP` (a query failed — Vercel, GA4, Search Console or the Google token swap — or a week has 0 US visitors; a source that is simply not configured is not a gap). A ratio flag needs a non-zero baseline average. Every flag line carries its numbers.

**GA4 (US, same 8 weeks).** Two Data API `runReport` calls on property `GA4_PROPERTY_ID`, both filtered to `countryId = US`: (1) `date × sessionSource × sessionMedium` with `sessions`, `totalUsers`, `keyEvents`, grouped into Monday weeks and bucketed as google/cpc, google/organic, (direct)/(none), chatgpt.com/referral (any source containing *chatgpt*, whatever the medium: GA4 labels these sessions `chatgpt.com / ai-assistant`, never `referral`, because ChatGPT appends `utm_source=chatgpt.com` to its links — and that UTM also means GA4 counts ChatGPT visits that arrive without a referrer, which Vercel files under no-referrer, so the GA4 ChatGPT column runs well above Vercel's), bing/organic, any source containing *linkedin*, else `other` (`weeks[].ga4.bySource`; `weeks[].ga4.topSources` lists the week's raw top-10 source/medium pairs so a new or oddly labelled referrer can be spotted in traffic.json); (2) `date × eventName` with `eventCount` for `form_submit`, `form_step2_complete`, `booking_confirmed`, `generate_lead`, whichever exist (`weeks[].ga4.events`; the table lists only events with a non-zero week). `users` is the sum of daily totalUsers, so a returning visitor counts once per day.

**Search Console (US, 16 weeks).** Property `sc-domain:rma-engineering.com` (the one gsc-inspect uses), four `searchAnalytics.query` calls with `country = usa` and `dataState = all` (fresh data included): clicks / impressions / impression-weighted average position by day → Monday weeks (`gsc.weeks`, 16); the same for brand queries (`query` matching `(?i)rma eng|rma-eng` → `gsc.weeks[].brand`); and the queries of the newest and the previous week, from which the top 25 by impressions (with the prior week's numbers) and the biggest movers over both weeks' top 25 are derived (`gsc.topQueries`). The newest week is `provisional` (marked `*` in the table) while its last day plus `provisionalLagDays` (3) is not yet behind the run date — Search Console revises the last ~3 days. The table shows the last 8 of the 16 weeks; `traffic.json` keeps all 16; each week's history file carries that week's `gsc` record.

**Google auth.** Service-account keys are blocked by the Google org policy, so CI uses the desktop OAuth refresh-token flow — the same client JSON `npm run gsc-inspect` uses in RMA-Engineering-Website (`GSC_OAUTH_CLIENT_FILE`, default `C:\Users\User\Documents\secrets\gsc-oauth-client.json`, never committed). Once, on a laptop that has that file: `node scripts/google-auth-once.mjs` → browser sign-in with scopes `analytics.readonly` + `webmasters.readonly` (`access_type=offline`, `prompt=consent`) → it prints `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, the matching `gh secret set` commands, the Search Console properties and the GA4 properties the token can read (copy the numeric id into `GA4_PROPERTY_ID`; it is not the `G-…` measurement id). In CI the refresh token is swapped for an access token at `https://oauth2.googleapis.com/token` on each run. When Google answers `invalid_grant` (token expired or revoked — refresh tokens of an OAuth app still in *Testing* expire after 7 days), both Google sources report `error: refresh token expired — rerun google-auth-once`, the Vercel part is unaffected, and `DATA_GAP` names the token swap. The Google Analytics Data API must be enabled in the OAuth client's GCP project (the Admin API only for the property listing in the auth script).

**Never blocks the snapshot.** The step runs with `continue-on-error`; the script always exits 0, writing whatever it has plus `DATA_GAP` when a call fails (the `Sources:` line at the bottom reads `Vercel ok (5/5 queries) · GA4 ok · Search Console ok`, or `not configured` / `error: …` per source). If the step still dies, the previous report is copied forward.

**Secret.** `VERCEL_TOKEN` (repo secret): a Vercel account token that can read Web Analytics for project `prj_zNoXiJrpzpACjqblulbPyFvfVOWp` on team `team_035xPAMeSLpAJV8bJITxjMtP` (both in `traffic.config.json`). Rotate it under Settings → Secrets and variables → Actions; nothing else changes. Never add `utmSource` / `utmMedium` to a query: they answer 402 on the current plan.

**By hand.** `VERCEL_TOKEN=… node scripts/traffic.mjs` (PowerShell: `$env:VERCEL_TOKEN='…'; node scripts/traffic.mjs`) writes `out/latest/traffic.{json,md}` and `out/history/traffic/*.json`; `OUT_DIR` and `HISTORY_DIR` move them. Or Actions → *Site snapshot* → *Run workflow* with the `pages` box empty. Test hooks: `TRAFFIC_NOW=2026-10-26T12:00:00Z` fixes "now" (window = the 8 complete weeks before that date); `TRAFFIC_FIXTURE_DIR=dir` reads `dir/<query>.json` (`us`, `referrers`, `paths`, `countriesNoRef`, `chatgptPages` for Vercel; `ga4-sources`, `ga4-events`, `gsc-weekly`, `gsc-brand`, `gsc-top-latest`, `gsc-top-prior` for Google, read only when the three `GOOGLE_OAUTH_*` variables are set to anything, the token swap being skipped; a saved raw API response or a bare rows array) instead of calling Vercel, and a missing file plays a failed query (expect `DATA_GAP`).

## Where things live

| Thing | Location |
|---|---|
| Gallery (humans) | `https://RMAEngineering.github.io/rma-site-snapshots/latest/` |
| Report | `.../latest/report.md` |
| Manifest (Claude) | `https://raw.githubusercontent.com/RMAEngineering/rma-site-snapshots/snapshots/latest/manifest.json` |
| Traffic report | `.../latest/traffic.md` (phone) and `.../snapshots/latest/traffic.json` (Claude) |
| Traffic history | `https://raw.githubusercontent.com/RMAEngineering/rma-site-snapshots/snapshots/history/traffic/<weekStart>.json`, one per complete week |
| Composites (Claude) | `.../snapshots/latest/pages/<slug>/fold.jpg` and `full.jpg` |
| 90-day archive | Actions → the run → Artifacts (`snapshot-<run id>.zip`) |

The `snapshots` branch is rewritten from scratch on every run (orphan commit, force-pushed), so the repo stays ~40 MB regardless of how many weeks it runs. Older runs live in the Actions artifacts for 90 days.

## Tuning

Everything is in `pages.config.json`: which pages (sitemap + extras, exclusions, how many blog posts), viewports, thresholds for flags (`loadMsWarn`, `lcpMsWarn`, `diffPctWarn`, `sitewideChangeShare`, `heightChangeWarn`, `minWordsWarn`), CTA patterns, link-check limits, axe tags, `bannedPhrases` / `allowPhrases`, `axe.sitewideShare`, `expectedFont`. No code changes needed for normal adjustments.

The traffic report has its own `traffic.config.json`: the Vercel endpoint, team and project ids, timeout and retries; the window (`weeks`, `baselineWeeks`); the referrers to keep; the page groups (regexes — `metro` is a pattern, so a new `*-product-development` page joins it automatically); the per-query `limit`s; the table's page columns; and every flag threshold (`usNoRefDownRatio`, `deepPagesDownRatio`, `adPagesDownRatio`, `trafficUpRatio`, `botShareSpikeRatio`, `botShareSpikeAbsolute`, `chatgptZeroWeeks`, `chatgptMaxAtLeast`, and for Google `brandImprDownRatio`, `organicDownRatio` + `organicDownMinAvg`, `chatgptDownRatio` + `chatgptDownMinAvg`, `gscImprDownRatio`, `ga4VsVercelGapShare`, `eventDropRatio` + `eventDropMinAvg` + `eventDropEvents`). The `google` block holds the token endpoint and scopes; `ga4` the country, the kept source/mediums, the *linkedin* source match and the event names; `gsc` the site URL, 16 weeks, `dataState`, the brand regex, the top-query counts and the provisional lag; `report.ga4Columns` and `report.gscWeeks` shape the two Google tables.

`thresholds.sitewideChangeShare` (default 0.8) is the rollup rule for visual changes. A page is *compared* when it has a diff against the previous run on at least one viewport, and *changed* when either viewport moved by ≥ `diffPctWarn`. When changed ÷ compared ≥ `sitewideChangeShare`, the change is one layout/template edit (header, footer, font, banner), not N page edits: the run reports it **once** — `summary.sitewideChange = { pages, compared, share, desktopAvgPct, mobileAvgPct }` in the manifest (the averages are the mean `pctChanged` over the compared views per viewport), one line under "Changes vs previous run" in report.md, a blue card at the top of the gallery — and removes the per-page `changed X% vs previous` flags. Each view's `diff` numbers, the `*_diff.jpg` images and the `page height ±N%` flags are kept, and `summary.changedPages` still lists every page. Below the share every page keeps its own "changed" flag, as before. At least 2 compared pages are required (a one-page run cannot make a sitewide claim).

`expectedFont` (default `"Inter"`) is what the body's computed `font-family` must start with. Each view records `getComputedStyle(document.body).fontFamily` as `views.<v>.fontFamily` (raw; Chromium reports `__Inter_d8ebd1, __Inter_Fallback_d8ebd1, system-ui, sans-serif`, other engines quote the idents). Only the **first** family in that list is compared, after normalization: surrounding quotes (if any), a leading `__` and a trailing `_<6 hex>` are stripped, because next/font renders the family as `__Inter_d8ebd1`; so `"__Inter_d8ebd1"` → `Inter`, which starts with `Inter` (case-insensitive) → no flag. When the first family is anything else the page gets one flag per offending family with the viewports that show it: `font: body font-family starts with 'Times New Roman', expected 'Inter' (desktop, mobile)` — exactly what the Oct 19 outage looked like, when a stale font class left `--font-inter` undefined for 30 minutes. `summary.fontMismatchPages` lists the pages, `summary.expectedFont` echoes the value in force. Set `expectedFont` to `""` to disable the check. The normalization lives in `scripts/checks.mjs` (`firstFontFamily`) and is unit-tested.

`ignoreAbortedRequests` lists URL patterns whose `net::ERR_ABORTED` failures are not flagged: Google Ads/GA beacons, Meta Pixel, HubSpot tracking, Vercel Analytics and Next.js `_rsc` prefetches. Browsers cancel these routinely when a page moves on, so they say nothing about the site. Only *aborted* requests are skipped. A 4xx/5xx or any other network error on the same URLs is still flagged. The per-view count of skipped requests is in the manifest as `ignoredAbortedRequests`.

`ignoreFailedRequests` is the stronger carve-out: a failed request whose URL *contains* one of these substrings (plain, case-sensitive) never flags, whatever the status code or network error. The only entry is `connect.facebook.net/log/error`, the Meta pixel's own error beacon, which answers 4xx by design and would otherwise show up as a "failed resources" flag on every page. The per-view count is `ignoredFailedRequests`. Keep this list short: anything on it is invisible to the run.

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

Test hooks, inert unless set: `BANNED_PHRASES_EXTRA="since 2020"` adds banned phrases for one run (positive test of the copy check); `SIMULATE_CHUNK_FAIL=once` fails the first `/_next/static/chunks` request on the first pass only (expect `retried: true`, no flag), `=always` makes it recur (expect the "chunk 404" flag); `EXPECTED_FONT=Georgia` overrides `expectedFont` for one run (expect every page flagged `font: body font-family starts with 'Inter', expected 'Georgia' (desktop, mobile)`); `SIMULATE_CHANGED=1` marks every view as changed (`pctChanged` forced to 100, `diff.simulated: true`; a diff is fabricated when there is no previous run) — with ≥2 pages expect `summary.sitewideChange` and no per-page "changed" flags; `SIMULATE_FAILED_REQUEST=<url>` makes every view load that URL once after load (as an image) and answers it with a synthetic 400 — with `https://connect.facebook.net/log/error?test=1` expect `ignoredFailedRequests: 2` per view (Playwright reports the synthetic 400 as a response event and an abort event; both are counted, neither flags) and no "failed resources" / "console errors" flag, with any other URL (e.g. `https://example.com/boom`) expect both flags.

Unit tests for the pure helpers (`scripts/checks.mjs`, `scripts/traffic-lib.mjs` — `tests/traffic.test.mjs` for Vercel and the week math, `tests/traffic-google.test.mjs` for GA4 / Search Console; no browser, no token): `npm test`.

## Cost

$0. Public-repo GitHub Actions minutes are free; each run uses ~5 minutes. The traffic report adds five Vercel Web Analytics calls, two GA4 Data API calls and four Search Console calls per week, plus one token swap.
