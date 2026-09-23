import { loadPointsRange, loadCrawlsRange, loadDailyRange, replaceDaily } from "./store.js";
import { medianRank } from "./series.js";

const DATA_DIR = "data";

/**
 * Roll up a single day.
 * date: "YYYY-MM-DD"
 */
async function rollupDay(date) {
  const points = await loadPointsRange(DATA_DIR, date, date);
  const crawls = await loadCrawlsRange(DATA_DIR, date, date);

  // Group by appId + country + platform + genreId + chart
  const groups = new Map();
  for (const p of points) {
    const key = `${p.app_id}|${p.country}|${p.platform}|${p.genre_id}|${p.chart}`;
    if (!groups.has(key)) {
      groups.set(key, {
        app_id: p.app_id,
        country: p.country,
        platform: p.platform,
        genre_id: p.genre_id,
        chart: p.chart,
        ranks: [],
      });
    }
    groups.get(key).ranks.push({ rank: p.rank, ts: p.ts });
  }

  // Number of successful crawls that day (used for hours_sampled)
  const crawlCounts = new Map();
  for (const c of crawls) {
    if (c.status !== "ok") continue;
    const key = `${c.country}|${c.platform}|${c.genre_id}|${c.chart}`;
    crawlCounts.set(key, (crawlCounts.get(key) || 0) + 1);
  }

  const dailyRows = [];
  for (const [, g] of groups) {
    const ranks = g.ranks.map((r) => r.rank);
    const crawlKey = `${g.country}|${g.platform}|${g.genre_id}|${g.chart}`;
    const hoursSampled = crawlCounts.get(crawlKey) || 0;

    // Sort by ts, take the last rank it was on chart
    const sorted = [...g.ranks].sort((a, b) => a.ts.localeCompare(b.ts));
    const closeRank = sorted.length > 0 ? sorted[sorted.length - 1].rank : null;

    dailyRows.push({
      date,
      country: g.country,
      platform: g.platform,
      genre_id: g.genre_id,
      chart: g.chart,
      app_id: g.app_id,
      best_rank: Math.min(...ranks),
      worst_rank: Math.max(...ranks),
      median_rank: medianRank(ranks),
      hours_on_chart: ranks.length,
      hours_sampled: hoursSampled,
      close_rank: closeRank,
    });
  }

  // For combos with crawls but no points (never on chart all day), write no row —
  // avoids daily rows full of nulls.
  // daily only records rows that were ever "on chart"; not being on chart is already
  // identifiable from crawls.

  return dailyRows;
}

/**
 * Get the date given by `--date`.
 */
function getTargetDate(args) {
  const dateIdx = args.indexOf("--date");
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    return args[dateIdx + 1];
  }
  // Fall back to yesterday when not given
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Check whether daily data already exists for that date.
 */
async function hasDaily(date) {
  const month = date.slice(0, 7);
  const existing = await loadDailyRange(DATA_DIR, [month]);
  return existing.some((r) => r.date === date);
}

async function main() {
  const args = process.argv.slice(2);
  const allDays = args.includes("--all");
  // Use when aggregation logic changed (e.g. a different median algorithm) and history
  // must be recomputed; otherwise already-rolled dates are skipped
  const forceAll = args.includes("--force");

  const today = new Date().toISOString().slice(0, 10);

  // Today is still being crawled and must be recomputed every hour, so it is never skipped;
  // past dates are skipped once rolled, to avoid a wasted run each time.
  async function rollAndWrite(date, { force }) {
    if (!force && !forceAll && (await hasDaily(date))) {
      console.log(`[rollup] ${date} already rolled, skip`);
      return 0;
    }
    const rows = await rollupDay(date);
    await replaceDaily(DATA_DIR, date, rows);
    console.log(`[rollup] ${date}: ${rows.length} daily rows`);
    return 1;
  }

  if (allDays) {
    // Process every date that has points data (including today, so a "one month" range
    // doesn't miss the current day)
    console.log("[rollup] processing all unrolled days...");
    const { listPointFiles } = await import("./store.js");
    const files = await listPointFiles(DATA_DIR);
    const dates = [...new Set(files.map((f) => f.date))].sort();

    let count = 0;
    for (const date of dates) {
      count += await rollAndWrite(date, { force: date === today });
    }
    console.log(`[rollup] done, processed ${count} days`);
  } else if (args.includes("--date")) {
    // Explicit date given, process only that day
    const date = getTargetDate(args);
    await rollAndWrite(date, { force: date === today });
  } else {
    // Default (no args): backfill yesterday + recompute today.
    // The workflow calls this hourly with no args; both must run, otherwise today's daily
    // is always empty.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await rollAndWrite(yesterday, { force: false });
    await rollAndWrite(today, { force: true });
  }
}

main().catch((err) => {
  console.error("[rollup] fatal:", err);
  process.exit(1);
});