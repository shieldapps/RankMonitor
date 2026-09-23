/**
 * Time-series assembly: aggregate points / crawls / rollup into bucket
 * series for the line chart.
 *
 * Design notes:
 * - Buckets are aligned to UTC boundaries; the bucket timestamp is always
 *   the "bucket start", keeping the x axis evenly spaced.
 * - Each bucket takes the median (ranks are ordinal data; the mean gets
 *   dragged around by extremes).
 * - When a bucket has no on-chart data, that point is left empty and given a
 *   status code; the frontend breaks the line and marks it accordingly.
 * - Distinguish "genuinely not ranked" from "this slot was never observed":
 *   the latter (future hours, days when crawling never ran) gets no marker and
 *   is excluded from the on-chart-rate denominator — otherwise when "today"
 *   has only 2 hours of data the on-chart rate would be computed as 2/24.
 */

/** Gap status codes. 0 means rank data is present. */
export const GAP = {
  ON_CHART: 0,
  NOT_ON_CHART: 1,
  DEPTH_LIMITED: 2,
  CRAWL_ERROR: 3,
};

/**
 * Align ts to the bucket start.
 * granHours = 1 → top of the hour; granHours = 6 → 00/06/12/18.
 */
export function bucketStart(ts, granHours) {
  const d = new Date(ts);
  if (granHours >= 24) {
    const days = Math.round(granHours / 24);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDate() - 1) % days));
  } else {
    d.setUTCHours(Math.floor(d.getUTCHours() / granHours) * granHours, 0, 0, 0);
  }
  return d.toISOString().replace(".000Z", "Z");
}

/**
 * Take the median. With an even count, take the smaller of the two middle
 * values so the result is always a rank that actually occurred, rather than
 * the average of two ranks.
 */
export function medianRank(ranks) {
  if (ranks.length === 0) return null;
  const sorted = [...ranks].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? sorted[mid - 1] : sorted[mid];
}

/**
 * Generate every bucket start between [fromDate, toDate], inclusive.
 * Steps in UTC milliseconds, so it is correct across months and years.
 */
export function bucketRange(fromDate, toDate, granHours) {
  const buckets = [];
  const end = new Date(toDate + "T23:59:59Z").getTime();
  const step = granHours * 3600 * 1000;
  let cur = new Date(bucketStart(fromDate + "T00:00:00Z", granHours)).getTime();
  while (cur <= end) {
    buckets.push(new Date(cur).toISOString().replace(".000Z", "Z"));
    cur += step;
  }
  return buckets;
}

/**
 * Group crawls by (country, platform, genre_id, chart), sorted by ts within
 * each group. Also records the max returned_count per platform for this round
 * (used to detect depth-limited results).
 */
export function indexCrawls(crawls) {
  const byBase = new Map();
  const maxByPlatform = new Map();
  for (const c of crawls) {
    const base = `${c.country}|${c.platform}|${c.genre_id}|${c.chart}`;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(c);
    if (c.status === "ok") {
      const cur = maxByPlatform.get(c.platform) || 0;
      if (c.returned_count > cur) maxByPlatform.set(c.platform, c.returned_count);
    }
  }
  for (const list of byBase.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { byBase, maxByPlatform };
}

/**
 * Look up the last crawl result within a bucket window
 * [bucketTs, bucketTs + granHours).
 *
 * Only search inside the bucket window. An earlier implementation searched
 * 2 hours on either side outside the bucket, so the last few hours of "today"
 * that had not happened yet would still match an afternoon crawl record and
 * conjure up extra "not on chart" points.
 * For multi-hour buckets (e.g. one week = 6 hours), take the newest observation
 * in the window.
 */
function findCrawl(crawlIndex, bucketTs, cc, platform, genreId, chart, granHours) {
  const list = crawlIndex.byBase.get(`${cc}|${platform}|${genreId}|${chart}`);
  if (!list || list.length === 0) return null;

  const start = bucketTs;
  const endMs = new Date(bucketTs).getTime() + granHours * 3600 * 1000;
  const end = new Date(endMs).toISOString().replace(".000Z", "Z");

  let found = null;
  for (const c of list) {
    if (c.ts < start) continue;
    if (c.ts >= end) break; // sorted, so the rest are later
    found = c;              // keep overwriting → take the last one in the window
  }
  return found;
}

/**
 * Determine the gap status of a chart at a given moment.
 * Reuses the depth-limited logic from crawl.js: returned count below the
 * platform max (tolerance 2) → depth-limited.
 * Returning null means there is no crawl record at that moment, so the
 * frontend draws no marker.
 */
export function gapStatusFor(crawlIndex, bucketTs, cc, platform, genreId, chart, granHours) {
  const c = findCrawl(crawlIndex, bucketTs, cc, platform, genreId, chart, granHours);
  if (!c) return null;
  if (c.status === "error") return GAP.CRAWL_ERROR;

  const platMax = crawlIndex.maxByPlatform.get(platform) || c.requested_limit || 100;
  return c.returned_count < platMax - 2 ? GAP.DEPTH_LIMITED : GAP.NOT_ON_CHART;
}

/** Build the result object for an empty bucket. */
function emptyBucketState(buckets) {
  return {
    values: new Array(buckets.length).fill(null),
    spans: new Array(buckets.length).fill(null),
    gaps: [],
    samples: 0,
    onChart: [],
    observed: 0,
  };
}

/**
 * Above this many sample points, stop drawing the range band.
 * In the one-year view, 365 points work out to ~3px each, so the range blocks
 * merge into a solid grey background — all noise, no information.
 */
const SPAN_MAX_BUCKETS = 180;

/** Summarize the per-bucket sample counts into stats fields. */
function summarize(state, buckets) {
  const onChart = state.onChart;
  return {
    values: state.values,
    spans: state.spans,
    gaps: state.gaps,
    samples: state.samples,
    // With a bucket width < 6 hours there is only ever one sample per bucket,
    // so a range is meaningless; same when points are too dense — the range
    // degenerates into noise
    showSpans: buckets.length <= SPAN_MAX_BUCKETS && state.spans.some((s) => s !== null),
    stats: {
      onChartBuckets: onChart.length,
      observedBuckets: state.observed,
      totalBuckets: buckets.length,
      best: onChart.length ? Math.min(...onChart) : null,
      worst: onChart.length ? Math.max(...onChart) : null,
      median: medianRank(onChart),
      samples: state.samples,
    },
  };
}

/** Fine-grained data source (today / 3 days / one week): points + crawls. */
function seriesFromPoints({ points, crawlIndex, appId, country, platform, genreId, chart, buckets, granHours }) {
  const bucketsByTs = new Map(buckets.map((b, i) => [b, i]));
  const ranksByBucket = new Map();

  for (const p of points) {
    if (p.app_id !== appId || p.country !== country || p.platform !== platform) continue;
    if (p.genre_id !== genreId || p.chart !== chart) continue;
    const bi = bucketsByTs.get(bucketStart(p.ts, granHours));
    if (bi === undefined) continue;
    if (!ranksByBucket.has(bi)) ranksByBucket.set(bi, []);
    ranksByBucket.get(bi).push(p.rank);
  }

  const state = emptyBucketState(buckets);

  for (let i = 0; i < buckets.length; i++) {
    const ranks = ranksByBucket.get(i);
    if (ranks && ranks.length > 0) {
      state.values[i] = medianRank(ranks);
      state.samples += ranks.length;
      state.onChart.push(state.values[i]);
      state.observed++;
      if (ranks.length >= 2) {
        state.spans[i] = [Math.min(...ranks), Math.max(...ranks)];
      }
      continue;
    }

    // No rank: count as "observed but not on chart" only if a crawl really ran;
    // otherwise it was never observed
    const code = gapStatusFor(crawlIndex, buckets[i], country, platform, genreId, chart, granHours);
    if (code === null) continue;
    state.gaps.push([i, code]);
    state.observed++;
  }

  return summarize(state, buckets);
}

/** Daily-grained data source (one month and up): rollup/daily. */
function seriesFromDaily({ dailyRows, appId, country, platform, genreId, chart, buckets, granHours, observedDates }) {
  const bucketsByTs = new Map(buckets.map((b, i) => [b, i]));
  const rowsByBucket = new Map();

  for (const r of dailyRows) {
    if (r.app_id !== appId || r.country !== country || r.platform !== platform) continue;
    if (r.genre_id !== genreId || r.chart !== chart) continue;
    const bi = bucketsByTs.get(bucketStart(`${r.date}T00:00:00Z`, granHours));
    if (bi === undefined) continue;
    if (!rowsByBucket.has(bi)) rowsByBucket.set(bi, []);
    rowsByBucket.get(bi).push(r);
  }

  const state = emptyBucketState(buckets);

  for (let i = 0; i < buckets.length; i++) {
    const rows = rowsByBucket.get(i);
    if (rows && rows.length > 0) {
      // With multiple days per bucket, take the median of the daily medians
      state.values[i] = medianRank(rows.map((r) => r.median_rank));
      state.samples += rows.reduce((s, r) => s + (r.hours_on_chart || 0), 0);
      state.onChart.push(state.values[i]);
      state.observed++;
      // The range uses each day's best_rank/worst_rank — those are the real
      // hourly extremes for that day, not aggregates over the bucket. So even
      // with "one bucket per day" the range is still meaningful.
      const hours = rows.reduce((s, r) => s + (r.hours_on_chart || 0), 0);
      if (hours >= 2) {
        state.spans[i] = [
          Math.min(...rows.map((r) => r.best_rank)),
          Math.max(...rows.map((r) => r.worst_rank)),
        ];
      }
      continue;
    }

    // No rollup row for the day = not on chart all day, but only if crawling
    // really ran that day. Test: the bucket-start day is in the global
    // observedDates (some other app/country wrote rows for it).
    const day = buckets[i].slice(0, 10);
    if (!observedDates.has(day)) continue;
    // Daily data comes from rollup, and crawls are only kept for 90 days, so
    // depth-limited cannot be distinguished; record it all as not on chart
    state.gaps.push([i, GAP.NOT_ON_CHART]);
    state.observed++;
  }

  return summarize(state, buckets);
}

/**
 * Build one series.
 *
 * Returns:
 *   values  — representative rank per bucket, null when there is no data
 *   spans   — [best, worst] per bucket, null when there are fewer than 2 samples
 *   gaps    — [[bucket index, status code], ...]
 *   samples — total samples across buckets
 *   stats   — statistics (with observedBuckets as the on-chart-rate denominator)
 */
export function buildSeries(opts) {
  return opts.granularity === "daily"
    ? seriesFromDaily(opts)
    : seriesFromPoints(opts);
}
