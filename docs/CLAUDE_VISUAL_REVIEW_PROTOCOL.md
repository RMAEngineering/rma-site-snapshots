# Visual review protocol — rma-engineering.com

**For:** Claude, in any chat in the RMA Engineering Project
**Source of truth:** the public repo `RMAEngineering/rma-site-snapshots`, branch `snapshots` (GitHub org: RMAEngineering, same org as the site repo RMA-Engineering-Website)
**Runs:** every Monday 7am ET, on demand (Actions → Run workflow), and after production deploys if the trigger is installed

Claude's sandbox cannot load rma-engineering.com directly, but it can read `raw.githubusercontent.com`. The snapshot workflow renders every page there, so Claude reviews the renders, not the live site.

## When to run this

- Reid says any of: "run the visual review", "check the site", "review the latest snapshot", "what changed after the deploy"
- Monday weekly review, if Reid asks for the site portion
- After Reid mentions a deploy and wants eyes on it — first check `generatedAt` in the manifest; if it predates the deploy, tell Reid to click *Run workflow* (or trigger it himself) and come back in ~5 minutes. Don't review stale renders as if they were current.

## Step 1 — pull the manifest (always first)

```bash
OWNER=RMAEngineering
R=https://raw.githubusercontent.com/$OWNER/rma-site-snapshots/snapshots/latest
mkdir -p /home/claude/snap && cd /home/claude/snap
curl -sfO $R/manifest.json && curl -sfO $R/report.md
python3 - <<'PY'
import json;m=json.load(open('manifest.json'))
print('generated',m['generatedAt'],'| previous',m['previousRun'],'| pages',m['summary']['pages'])
print('flagged',m['summary']['pagesWithFlags'],'| changed',m['summary']['changedPages'],'| new',m['summary']['newPages'],'| removed',m['summary']['removedPages'])
print('broken internal links',m['summary']['brokenInternalLinks'])
for a in m['alerts']: print('\n',a['path']); [print('   -',f) for f in a['flags']]
PY
```

Read `report.md` too — it has the per-page table (status, load, LCP, words, CTA counts, a11y counts, diff %).

## Step 2 — decide what to look at

Default scope, in this order:

1. Every page in `summary.changedPages` (something actually changed)
2. Every page with flags that are visual in nature (overflow, broken images, oversized images, height change)
3. The four key pages regardless: `/`, `/contact-us`, `/inventors`, `/reality-check`
4. New pages

Skip pages that are unchanged and unflagged unless Reid asks for a full pass. A full pass of all ~28 pages is fine when Reid asks for it (roughly 60 images).

## Step 3 — download and view the composites

Per page there are two images built for Claude:

- `pages/<slug>/fold.jpg` — desktop (1440×900) and mobile (390×844) **above the fold**, side by side
- `pages/<slug>/full.jpg` — top 3000 px of the desktop (at 800 wide) and mobile (at 400 wide) **full page**, side by side
- `pages/<slug>/desktop_diff.jpg` / `mobile_diff.jpg` — only when the page changed; red = changed pixels

```bash
cd /home/claude/snap
for s in home contact-us inventors reality-check; do
  for f in fold full; do curl -sf -o ${s}_$f.jpg $R/pages/$s/$f.jpg; done
done
```

Then use the `view` tool on each file. Slugs: `/` → `home`; otherwise strip the leading slash and replace `/` with `_` (`/services/design-services` → `services_design-services`).

## Step 4 — what to give feedback on

Look at each composite the way a first-time visitor would, desktop and mobile separately:

- **Above the fold:** is the headline + primary CTA visible without scrolling on mobile? Does the banner/header stack eat the fold?
- **Hierarchy:** one obvious next action per screen; CTA contrast; nothing competing with the form on `/contact-us`
- **Mobile specifics:** text size, tap target spacing, images that got tiny or cropped, cards that stack into a wall
- **Trust signals:** BBB seal, "since 2020", IP-ownership line, 1-business-day reply promise — present and accurate (not "10+ years", not "12 hours")
- **Copy drift:** anything on screen that contradicts current positioning (see project context docs)
- **Consistency:** same header/banner behavior across pages; footer links; metro pages don't look templated in a way that reads as thin

Combine with the manifest's structural flags so the feedback is one list, not two.

## Step 5 — report format (Reid reads on his phone)

1. **Bottom line** — one or two sentences: is the site healthy, what changed, anything urgent
2. **Fix now** — up to 3 items with page + what + why, structural flags included
3. **Worth doing** — the rest, short
4. **Changed since last run** — what moved and whether it looks right
5. **Didn't look at** — pages skipped, so Reid knows the coverage

Real numbers, not adjectives. If nothing meaningful changed, say so in one line and stop.

## Thresholds (from pages.config.json)

| Flag | Threshold |
|---|---|
| slow load | > 3000 ms |
| visually changed | ≥ 3% pixels vs previous run |
| page height change | ≥ 10% |
| oversized image | served at > 2× its displayed width |
| thin page | < 120 words |
| a11y | any critical or serious axe violation |
| banned phrase | any of pages.config.json `bannedPhrases` in visible text (case-insensitive), unless an `allowPhrases` entry is within 40 chars |

## If the manifest fetch fails

- 404 on the raw URL → the workflow hasn’t run yet (or the repo was created under a different owner). Ask Reid to run it once.
- `generatedAt` older than a week → the schedule may be paused (GitHub disables scheduled workflows after 60 days without activity on the repo). Ask Reid to click *Run workflow*, which re-enables it.
