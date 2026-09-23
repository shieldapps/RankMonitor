# RankMonitor

App Store category-chart rank monitoring for macOS, iOS and iPadOS.

RankMonitor watches where your apps — and a list of competitor apps — sit in the
App Store category charts, hour by hour, across many storefronts. It reads Apple's
public RSS feeds, so there are **no API keys, no App Store Connect account, and no
database**. The output is a static HTML dashboard you can open from disk or publish
to GitHub Pages.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Output and data files](#output-and-data-files)
- [Dashboard](#dashboard)
- [Deployment](#deployment)
- [Local vs. GitHub Actions](#local-vs-github-actions)
- [FAQ](#faq)
- [License](#license)

---

## Features

- **No credentials.** Apple's chart feeds are open JSON; nothing to sign up for.
- **Hourly time series.** Every run appends one row per chart it observed, so you get
  real intra-day movement, not just a daily snapshot.
- **Own apps vs. competitors.** Each tracked app can carry a list of competitor IDs.
  The dashboard plots them on the same axes.
- **Honest "not on chart" semantics.** The tool distinguishes *genuinely off the chart*
  from *we couldn't see deep enough* and from *the request failed*. See
  [Gap states](#gap-states).
- **Multi-country.** Charts are polled per storefront; core and secondary storefronts
  are styled differently.
- **Zero-dependency runtime.** Node.js 20+ with the built-in `fetch` — there is no
  `node_modules`. The generated dashboard loads ECharts from a CDN, so viewing it
  requires network access.

## How it works

```
                    ┌─────────────┐
  once an hour      │  crawl.js   │
  (local loop or    │  --once     │
   GitHub Actions)  └──────┬──────┘
                           │ writes three artefacts
        ┌──────────────────┼───────────────────────┐
        ▼                  ▼                       ▼
  points/*.jsonl      crawls/*.jsonl         current.json
  (rank of each       (how many entries      (latest snapshot;
   tracked app,        each chart returned,   read by the matrix
   only when it        used to detect         table, not by the
   is on the chart)    depth shortage)        history charts)
        │
        ▼  hourly / manual
  ┌──────────────┐
  │  rollup.js   │  aggregate → per-day median
  └──────┬───────┘
         ▼
  rollup/daily/*.jsonl
  (one row per day per app × country × chart,
   kept forever, serves the ≥30-day ranges)

        ────────────────────────────────
        ▼  when the dashboard is built
  ┌─────────────────────────────────────┐
  │  buildHistory()  in dashboard.js     │
  │  • ≤7-day ranges read points+crawls  │
  │  • ≥30-day ranges read rollup/daily  │
  │  • all ranges × app × country are    │
  │    computed once and embedded into   │
  │    public/index.html                 │
  └─────────────────────────────────────┘
        ▼
  open index.html in a browser → switching range/app/country
  is a pure client-side redraw with no network fetch
```

**The history curves do not come from `current.json`.** That file is only the latest
snapshot, used by the matrix table and the "current rank" stat blocks. The curves come
from `points` (hourly, ≤7 days) and `rollup/daily` (daily, ≥30 days).

**Why every range is precomputed at build time:** the dashboard is rebuilt hourly by
CI, and the reader cannot trigger another CI run just by switching a dropdown. So all
seven ranges for every app × country combination are serialized into the HTML up front.

### Branches

| Branch | Contents |
|--------|----------|
| `main` | Source code, `config/monitor.json`, GitHub Actions workflows |
| `data` | Crawl results only. Expected to be noisy — one commit per run |
| `gh-pages` | The generated static dashboard |

Keeping data off `main` avoids committing a binary or high-churn file into the code
history 24 times a day.

## Requirements

| Requirement | Notes |
|-------------|-------|
| Node.js **20 or 22 LTS** | Uses the built-in `fetch`; matches `actions/setup-node` in CI |
| Network access to `itunes.apple.com` | Both the lookup endpoint and the RSS feeds |
| Writable `data/` directory | Files for a single day are small |

Not required: Xcode, Python, Docker, PostgreSQL, Cloudflare, or any GitHub token for
purely local use. Intel and Apple Silicon are both fine.

```bash
node -v    # ≥ 20
curl -sI "https://itunes.apple.com/lookup?id=6754816629"
curl -s "https://itunes.apple.com/us/rss/topfreemacapps/limit=10/genre=6000/json" | head
```

If you don't have Node: `brew install node@22`, or install the LTS build from nodejs.org.

## Quick start

```bash
git clone git@github.com:shieldapps/RankMonitor.git
cd RankMonitor

# 1. Pull one round of rankings
node src/crawl.js --once

# 2. Build the dashboard and open it
node src/dashboard.js
open public/index.html
```

The browser shows a matrix table: rows are your tracked apps, columns are storefronts,
and each cell holds the current rank plus the change versus the previous round.

### Suggested first-run checklist

1. Start with **one app and one competitor** in `config/monitor.json`, then run
   `node src/crawl.js --once`.
2. Check that `crawls` succeeded, that `points` recorded a hit, and that a Mac app only
   ever appears under `macos`.
3. Run `--loop --interval 900` for four to six rounds. Confirm the JSONL files are
   **appended** to, that `ts` is aligned to the hour, and that an app which is off the
   chart is never written as rank `0`.
4. Run `node src/dashboard.js` and open `public/index.html`.
5. Only then fill in the full app list. While validating locally, **leave Actions off**,
   or both sides will write the same day's files.
6. Once satisfied, let the workflow call `--once` on a schedule.

## CLI reference

| Command | What it does | Typical duration |
|---------|--------------|------------------|
| `node src/crawl.js --once` | One round: fetch RSS, write `points`/`crawls`, regenerate `current.json` | ~30 s |
| `node src/crawl.js --loop --interval 3600` | Repeat every hour until Ctrl+C | ~30 s per round, then idle |
| `node src/crawl.js --loop --interval 900` | Repeat every 15 minutes | idem |
| `node src/rollup.js` | Backfill yesterday and recompute today's daily rows | < 1 s |
| `node src/rollup.js --all` | Backfill every historical day (today is force-recomputed) | a few minutes |
| `node src/rollup.js --date 2026-09-10` | Compute a single day | < 1 s |
| `node src/rollup.js --all --force` | Recompute every day, including ones already done | a few minutes |
| `node src/dashboard.js` | Generate `public/index.html` from `data/` | < 1 s |
| `node src/cleanup.js --older-than 90` | Delete `points` and `crawls` older than 90 days | < 1 s |

`crawl.js` defaults to `--once` when no flag is given.

In loop mode the dashboard is not opened automatically. Open it in a second terminal:

```bash
node src/dashboard.js && open public/index.html
```

Closing a laptop lid suspends the loop. To keep it alive:

```bash
caffeinate -dims node src/crawl.js --loop --interval 3600
```

## Configuration

Everything lives in `config/monitor.json`. Note that JSON does not allow comments, so
the field documentation lives here.

```json
{
  "charts": ["top-free"],
  "platforms": ["macos", "ios", "ipados"],
  "categories": ["Business", "Productivity", "Utilities"],
  "countries": {
    "core": ["us", "gb", "ca", "fr", "de", "jp"],
    "secondary": ["au", "es", "it", "pt", "ch", "be", "nl", "tw", "hk", "nz", "sg", "in", "za", "br"]
  },
  "timezone": "UTC",
  "apps": [
    {
      "id": "6754816629",
      "platforms": ["macos"],
      "competitors": ["1573153845", "6501959391"]
    }
  ]
}
```

The minimal entry is just `{ "id": "..." }`.

### Field reference

| Field | Required | Default when omitted |
|-------|----------|----------------------|
| `id` | Yes | — |
| `competitors` | Recommended | Track only yourself, no comparison |
| `platforms` | **Recommended** | Inferred from the lookup `kind`: `mac-software` → `macos` only; `software` → `ios` + `ipados` |
| `categories` | No | The app's primary genre from lookup, when it is one of the monitored categories |
| name / icon | No | Fetched automatically by lookup |

**Always set `platforms` by hand.** A Mac App Store ID will never appear in the iPhone
charts and would be permanently reported as "not on chart".

The global `platforms` and `categories` are **upper bounds**. The set actually scanned
for a given app is the intersection of the global lists with that app's own settings.

A product that ships both a Mac and an iOS build has **two different App Store IDs** and
therefore needs **two entries**. Competitors are attached per platform entry.

If the same competitor appears under two products, its rank is still stored only once.

`timezone` defaults to `"UTC"` and defines the midnight boundary used for daily
aggregation. It does **not** change what is fetched, and it does **not** change how the
dashboard renders times. The shipped configuration uses UTC.

### Genre IDs and RSS paths

Category names map to Apple genre IDs:

| Name | `genre` |
|------|---------|
| Business | `6000` |
| Productivity | `6007` |
| Utilities | `6002` |

Chart names map to RSS path segments:

| `chart` value | `macos` segment | `ios` segment | `ipados` segment |
|---------------|-----------------|---------------|------------------|
| `top-free` | `topfreemacapps` | `topfreeapplications` | `topfreeipadapplications` |
| `top-paid` *(reserved)* | `toppaidmacapps` | `toppaidapplications` | `toppaidipadapplications` |
| `top-grossing` *(reserved)* | `topgrossingmacapps` | `topgrossingapplications` | `topgrossingipadapplications` |

The URL is assembled as:

```text
https://itunes.apple.com/{country}/rss/{platformSegment}/limit=200/genre={genreId}/json
```

For example:

```text
macos  + top-free + Business      → /us/rss/topfreemacapps/limit=200/genre=6000/json
ios    + top-free + Productivity  → /us/rss/topfreeapplications/limit=200/genre=6007/json
ipados + top-free + Utilities     → /us/rss/topfreeipadapplications/limit=200/genre=6002/json
```

The array order *is* the ranking; `id.attributes["im:id"]` is the App Store ID.

Metadata comes from the lookup endpoint, at most 100 IDs per request:

```text
https://itunes.apple.com/lookup?id=id1,id2,id3
```

Lookup is refreshed once per day, before the first crawl round of the day. Fields that
matter here include `trackName`, `kind`, `primaryGenreName`/`primaryGenreId`,
`version`, `currentVersionReleaseDate` (when a competitor last updated),
`fileSizeBytes`, `bundleId`, `artworkUrl512`, `averageUserRating`, `userRatingCount`,
and `price`/`formattedPrice`/`currency`.

**Lookup cannot see in-app purchases or subscriptions.** The public endpoint does not
return IAP SKUs, prices or billing periods; that requires the App Store Connect API,
which is authenticated and only exposes your *own* apps. Competitor IAP data is simply
not available through public endpoints.

### Request volume

The set of charts to fetch is the union of platforms and genres required by all tracked
apps (including competitors), multiplied by the storefront list and the chart list.

Worst case, with every platform and genre in use: `countries × 3 × 3`. For the shipped
configuration — one platform, three genres, twenty storefronts — that is
`20 × 1 × 3 = 60` requests per round.

Requests run **serially** by default, pausing 10 seconds after each one, and retry once
after a 2-second delay on failure. With the shipped configuration that is roughly
60 × 10 s ≈ **10 minutes per round**, which is comfortably inside the hourly budget but
is worth knowing before you add storefronts or categories. Both knobs are environment
variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `RSS_CONCURRENCY` | `1` | Number of parallel request workers |
| `RSS_INTERVAL_MS` | `10000` | Pause after each request, in milliseconds |

The defaults are deliberately gentle on Apple's endpoint. Only the ranks of watched IDs
are stored; the full top 200 is never persisted.

### Failure handling

- A failed chart is retried once after a 2-second delay.
- A single failed chart does not abort the round: it is recorded as
  `crawls status=error` with an `error` field, and the next chart is fetched.
- Successful charts still write their `rank_points`. A failed chart writes only the
  `crawls` error row and shows up on the dashboard as "unknown for this hour" — it is
  never treated as an app dropping off the chart.
- `rank_points` is skipped entirely only if the whole round fails.

## Output and data files

Everything is written under `data/`, which is gitignored on `main` and lives on the
`data` branch.

| Path | Contents |
|------|----------|
| `data/meta/apps.json` | Lookup cache; refreshed once a day |
| `data/points/YYYY/MM/DD.jsonl` | Hourly rank hits for the day, one appended row per round |
| `data/crawls/YYYY/MM/DD.jsonl` | One row per chart request, used to detect depth shortage and failures |
| `data/rollup/daily/YYYY-MM.jsonl` | Per-day aggregation, computed by the script, never re-fetched from Apple |
| `data/current.json` | The latest round's matrix data, read directly by the dashboard |
| `public/index.html` | The generated static dashboard |

### Record types

**`crawls`** — proof that a chart was polled this hour.

| Field | Notes |
|-------|-------|
| `ts` | Aligned to the scheduled hour, ISO UTC, e.g. `2026-09-10T03:00:00Z` |
| `country`, `platform`, `genre_id`, `chart` | The chart identity |
| `status` | `ok` or `error` |
| `requested_limit` | The `limit` sent (currently a fixed 200) |
| `returned_count` | How many entries actually came back (≤ `requested_limit`) |
| `error` | Present only on failure |

**`rank_points`** — written only when the app is actually found on the chart. No
placeholder rows.

| Field | Notes |
|-------|-------|
| `ts` | Same hour as the corresponding `crawls` row |
| `country`, `platform`, `genre_id`, `chart`, `app_id` | The chart identity plus the app |
| `rank` | 1–200 |
| `name_at_time` | The store name at that moment |

**`rank_daily`** — produced by `rollup.js`, never re-fetched from Apple.

| Field | Notes |
|-------|-------|
| `date` | Day boundary per `config.timezone` (UTC in the shipped config) |
| `country`, `platform`, `genre_id`, `chart`, `app_id` | |
| `best_rank` / `worst_rank` / `median_rank` | Computed over hours on chart only |
| `hours_on_chart` | Number of hours with a rank |
| `hours_sampled` | Number of successful crawls that day |
| `close_rank` | Last rank of the day; empty if never on chart |

Weekly and monthly views are aggregated from `rank_daily` — they never re-crawl.

**`current.json`**

```json
{
  "generated_at": "2026-09-10T03:10:00Z",
  "data_ts": "2026-09-10T03:00:00Z",
  "rows": [
    {
      "app_id": "6754816629",
      "name": "Example App",
      "is_ours": true,
      "platform": "macos",
      "genre_id": 6000,
      "chart": "top-free",
      "countries": {
        "us": { "rank": 18,   "status": "on_chart",     "delta": 2 },
        "gb": { "rank": null, "status": "not_on_chart", "delta": null },
        "pt": { "rank": null, "status": "depth_limited","delta": null },
        "br": { "rank": null, "status": "crawl_error",  "delta": null }
      }
    }
  ]
}
```

`generated_at` is when the script ran; `data_ts` is the aligned hour. The dashboard
displays `data_ts`.

### Gap states

The chart feeds do not always return a full 200 entries. A small storefront in a small
category may return far fewer — so "not found" is ambiguous, and the tool resolves it
using `crawls.returned_count`:

| Condition | Meaning | Rendering | Alerts |
|-----------|---------|-----------|--------|
| Found on the chart | Real rank | Solid line + point | Normal |
| Returned a full set, not found | Genuinely off the chart | **Line break** | May alert "dropped off" |
| Returned fewer entries, not found | Depth shortage — might be ranked beyond what was returned | **Dashed / grey marker** | No alert |
| `crawls status=error` | Unknown for this hour | Grey marker | No alert |

If an app is ranked #120 but the endpoint only returned 100 entries, it is a depth
shortage, not an app that fell off the chart.

`delta` is `current round rank − previous round rank`, so a **positive value means the
rank number grew, i.e. the app moved down**. The previous round is the latest `points`
row with `ts` strictly earlier than the current round; the search spans back into
yesterday so that the first round of each day still has a baseline. When there is no
previous round, `delta` is `null` and the cell shows only the rank.

This is the opposite sign convention from many third-party rank emails, which use
positive numbers for upward movement. The dashboard labels the arrows explicitly.

### Retention and cleanup

| Directory | Retention | Notes |
|-----------|-----------|-------|
| `points/` | **90 days** | Hourly raw hits; safe to delete when stale |
| `crawls/` | **90 days** | Request log, cleaned alongside `points` |
| `rollup/daily/` | **Forever** | Tiny per-day aggregate rows |
| `meta/apps.json` | **Forever** | Overwritten by the next lookup |

```bash
node src/cleanup.js --older-than 90   # the flag defaults to 90 when omitted
```

The script scans `data/points/` and `data/crawls/`, takes each file's date from its
`YYYY/MM/DD.jsonl` filename, removes anything older than "current UTC date − N days",
prints what it deleted, and exits. `meta/` and `rollup/daily/` are never touched.

Deleting files only adds a new commit on the `data` branch — it does **not** shrink the
repository's history. The file count stops growing, but a fresh clone still gets larger
over the years. That is acceptable at this scale; if clones ever become slow, squash the
`data` branch or start a new one.

To reset everything — for example after a large configuration change — delete the data
directory:

```bash
rm -rf data/
```

The next `--once` performs a fresh lookup and starts collecting from zero. `public/` is
unaffected and can be kept.

**Note:** because `cleanup` only keeps 90 days of `points`/`crawls` while
`rollup/daily` is kept forever, history older than three months is only available at
daily granularity — and at that granularity "off the chart" and "depth shortage" can no
longer be distinguished, so both render as "off chart".

## Dashboard

`node src/dashboard.js` writes a single self-contained `public/index.html`.

| View | Purpose |
|------|---------|
| Matrix table | Rows are tracked apps, columns are storefronts, cells hold the current rank and the change vs. the previous round. Filterable by platform, genre, and core/secondary storefront |
| Line chart | One app, either a single storefront or the core storefronts overlaid. Y axis is inverted (rank 1 at the top) |
| Competitor overlay | Same country + platform + primary genre, your app against its competitors |
| Rank-gap view | `my rank − competitor rank`; negative means you are ahead |

Pie charts are deliberately avoided: rank is not a share.

### Time ranges and sampling

| Range | Bucket width | Value per point | Points | Source |
|-------|--------------|-----------------|--------|--------|
| Today | 1 hour | Raw rank (one per hour) | ~24 | `points` |
| 3 days | 1 hour | Raw rank | ~72 | `points` |
| One week | 6 hours | Median within the bucket | ~28 | `points` |
| One month | 1 day | Median of the day | ~30 | `daily` |
| 3 months | 1 day | Median of the day | ~90 | `daily` |
| 6 months | 1 day | Median of the day | ~180 | `daily` |
| One year | 1 day | Median of the day | ~365 | `daily` |

Buckets align to UTC boundaries and are timestamped at the bucket start, which keeps the
x axis evenly spaced. With `granHours=1` that is the top of the hour, `=6` gives
00/06/12/18, and `=24` gives midnight.

**Why the median rather than the mean:** rank is ordinal, and a mean gets dragged around
by outliers. For an even number of samples the lower of the two middle values is used,
so the displayed value is always a rank that genuinely occurred rather than an average
of two ranks.

The ≤7-day ranges read `points` for hourly detail; the ≥30-day ranges read
`rollup/daily`, because `cleanup` only retains 90 days of the raw data.

Everything is in UTC: bucketing, daily aggregation, and every timestamp the dashboard
shows — the header line, the x-axis labels, the tooltips and the table view. Stored
values carry an explicit `Z` suffix, and displayed times are the same instant, so no
offset is applied anywhere.

### Chart legend

| Legend entry | Meaning |
|--------------|---------|
| Rank | The representative rank for each sample point; the line is broken where data is missing |
| Range | Best-to-worst rank inside the bucket; shown only when a bucket holds more than one sample |
| Off chart | Rank missing and the chart returned a normal number of entries — genuinely unranked |
| Depth shortage | Rank missing and the chart returned few entries — possibly ranked beyond the returned range |
| Crawl failed | The request for that chart failed this round |

Missing segments are **broken, not interpolated**. Connecting across an off-chart period
would imply the app was ranked the whole time when it was not.

Below the chart there is a table view giving the exact value of every sample point.

### Gap marker shapes

| State | Code | Shape | Colour |
|-------|------|-------|--------|
| On chart | 0 | Line + dot | Blue |
| Off chart | 1 | Diamond | Red |
| Depth shortage | 2 | Triangle | Orange |
| Crawl failed | 3 | Cross | Grey |

Isolated points always get a dot because there is no line to carry them; points that
connect to a neighbour do not, since the line already expresses them.

**"Not observed" is not the same as "not ranked".** Hours that have not happened yet, or
days on which no crawl ran at all, are not marked and are excluded from the on-chart
ratio denominator — otherwise "today" would report a ratio over a full 24 hours when
only two hours have been collected. Only moments that have an actual crawl record and no
rank are marked.

**On the one-year range the x axis always spans the full period.** Hours that have passed
but not yet been sampled are not marked and do not count toward the denominator; blank
space simply means "not yet".

Depth shortage is decided by comparing this round's `returned_count` against the maximum
returned count for that platform: fewer than the platform maximum minus 2 is a shortage,
otherwise the app is genuinely unranked.

### Dark mode and empty states

The dashboard follows a `data-theme` attribute backed by `localStorage`, with colours
driven by CSS variables. Selecting a combination with no data shows a centred message
rather than an empty canvas.

### Alerts (not implemented)

Alerting is **designed but not built**. Nothing in the current code emits an alert;
the dashboard is purely visual. The intended design, for anyone picking it up:

- Delivered to the terminal or the GitHub Actions job summary — email is deliberately
  out of scope.
- Triggered only for **core storefronts**, in the app's **primary genre**.
- Trigger conditions: an app entering or leaving the chart, a single-round change of 20
  or more, or a competitor moving from behind to ahead.
- Secondary storefronts would appear in the matrix table but never raise alerts.

### Relationship to App Store Connect

This tool measures **visibility** — chart position. App Store Connect measures
downloads, trials and revenue. A strong position in a small storefront frequently does
not line up with revenue from a core storefront, so do not make decisions from chart
presence counts alone.

## Deployment

### GitHub Actions

Two workflows are included.

`hourly.yml` runs the pipeline: check out `main`, restore `data` from the `data`
branch, run crawl → rollup → dashboard, push the data back to `data`, and publish
`public/` to `gh-pages`.

```yaml
on:
  workflow_dispatch:

concurrency:
  group: rank-crawl
  cancel-in-progress: false

permissions:
  contents: write
  pages: write
```

`cleanup.yml` performs the 90-day cleanup on manual dispatch. Both workflows ship with
their `schedule` block commented out, because they are driven externally — see below.

Setup checklist:

1. Push the code to the repository.
2. In **Settings → Actions → General**, make sure Actions are enabled.
3. In **Settings → Pages**, set the source to the `gh-pages` branch.
4. Trigger a run from the **Actions** tab with **Run workflow**.

**Never run the local loop at the same time as Actions**, or both will write the same
day's files and conflict.

Scheduled workflows can be delayed by 5–15 minutes during peak times, which is
acceptable for hourly rank data.

### Scheduled triggering with cron-job.org

GitHub's built-in `schedule` trigger is frequently delayed or skipped during busy
periods, so an external scheduler is used to fire the workflow deterministically.

```
cron-job.org  ──POST every hour──▶  GitHub API (workflow_dispatch)
                                          │
                                          ▼
                                    hourly.yml runs
                                          │
                       data pushed to the data branch,
                       dashboard pushed to gh-pages
```

**Step 1 — create a GitHub personal access token.**

1. Open <https://github.com/settings/tokens>.
2. Choose **Generate new token → Generate new token (classic)**.
3. Set a note such as `cron-job.org trigger`, choose an expiration (or no expiration if
   you will rotate it manually), and check the **`workflow`** scope only.
4. Generate it and copy the value — it is shown only once.

**Step 2 — create a cron-job.org account.**

1. Open <https://cron-job.org/> and choose **Sign Up**.
2. Register with an email and password, or sign in with Google/GitHub.
3. Confirm the verification email and open the dashboard.

**Step 3 — create the cron job.**

| Field | Value |
|-------|-------|
| Title | `RankMonitor crawl trigger` |
| URL | `https://api.github.com/repos/shieldapps/RankMonitor/actions/workflows/hourly.yml/dispatches` |
| Request method | `POST` |

Add two request headers:

| Header | Value |
|--------|-------|
| `Authorization` | `token <the token from step 1>` |
| `Accept` | `application/vnd.github+json` |

Set the body to **Custom** with:

```json
{"ref":"main"}
```

For scheduling, either tick the **Every Hour** preset or use the cron expression
`17 * * * *`, which fires at minute 17 of every hour and avoids the top-of-hour crush.

**Step 4 — verify.** Use **Run** on the job in cron-job.org, then check the **Actions**
tab of the repository for a new `Hourly Crawl` run.

Notes:

- **Treat the token as a secret.** If it leaks, delete it on GitHub and generate a new one.
- The `schedule` blocks in the workflows are commented out, so there is no conflict with
  the external trigger. To pause collection temporarily, set the cron-job.org job to
  **Disabled**.
- To change the frequency, edit the scheduling expression — `17 */1 * * *` is hourly.

## Local vs. GitHub Actions

| | Local Mac | GitHub Actions |
|--|-----------|----------------|
| Command | `--once` or `--loop` | `--once` only, triggered externally |
| Data location | `./data` | Checked out from the `data` branch and committed back |
| Network | Your connection | Usually an overseas egress, so RSS tends to be more reliable |
| Sleep | The loop stops when the lid closes | Unaffected |
| Credentials | None | The default `GITHUB_TOKEN` for pushing branches |

Actions must **never** use `--loop`: every run is a fresh container, so looping is
pointless and burns minutes. At roughly 10 minutes per hourly run that is about 7,200
runner-minutes a month — free and unmetered for public repositories, but a private
repository on the free plan (2,000 minutes) would run out. Lower `RSS_INTERVAL_MS` or
raise `RSS_CONCURRENCY` if you need the round to finish faster.

Automated commits to the `data` and `gh-pages` branches are authored by a bot identity,
not by a human account, so they do not appear in anyone's contribution graph.

## FAQ

**`fetch failed` when running locally.**
`itunes.apple.com` can be slow from some networks. Use a proxy, or run on Actions, whose
egress is overseas.

**My app is clearly ranked but shows "depth shortage".**
Some small storefronts return far fewer than 200 entries for niche categories. Your app
is ranked beyond the returned range, so its position cannot be determined. This is a
limitation of the endpoint and cannot be worked around.

**Can I view the dashboard on my phone?**
Yes — once Actions publishes to `gh-pages`, the page is reachable from any device. On a
local-only setup, open `public/index.html` in a browser on the Mac.

**Why does my Mac app show "off chart" everywhere in the iOS charts?**
Mac App Store IDs never appear in iOS feeds. Make sure the entry's `platforms` is
`["macos"]` only.

**Why are there gaps on the right-hand side of the "Today" chart?**
The x axis always spans the whole period. Hours that have not been sampled yet are left
blank and excluded from the on-chart ratio — blank means "not yet", not "not ranked".

**Why is my rank average not a whole number in some views?**
It shouldn't be — medians are used, and for an even sample count the lower of the two
middle values is chosen, so the displayed number is always a rank that actually occurred.

**Do I need an Apple developer account?**
No. Everything uses Apple's public RSS and lookup endpoints. An App Store Connect API
key would only be needed for download or revenue data, which this tool does not collect.

## License

[MIT](LICENSE) © Shield Apps
