import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { batchLookup, needsLookup, loadMeta, saveMeta } from "./lookup.js";
import { expandRequests, fetchAllRss } from "./rss.js";
import { appendCrawls, appendPoints, loadCrawlsRange, loadPointsRange } from "./store.js";
import { log } from "./logger.js";

const DATA_DIR = "data";
const CURRENT_PATH = join(DATA_DIR, "current.json");

/**
 * Align ts to the scheduled hour.
 */
function alignTs(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUTC() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

/**
 * Generate current.json.
 * platformMaxCount: { macos: 100, ios: 100 } — max entries returned per platform this round,
 * used to tell "depth limited" apart from "genuinely not on chart".
 */
async function generateCurrent(ts, config, appMetaMap, points, crawls, prevPoints, platformMaxCount) {
  const { countries } = config;
  const allCountries = [...countries.core, ...countries.secondary];
  const ourIds = new Set(config.apps.map((a) => String(a.id)));

  // Build the previous round's rank index
  const prevRankMap = new Map();
  for (const p of prevPoints) {
    const key = `${p.app_id}_${p.country}_${p.platform}_${p.genre_id}_${p.chart}`;
    prevRankMap.set(key, p.rank);
  }

  const curRankMap = new Map();
  for (const p of points) {
    const key = `${p.app_id}_${p.country}_${p.platform}_${p.genre_id}_${p.chart}`;
    curRankMap.set(key, p.rank);
  }

  const crawlMap = new Map();
  for (const c of crawls) {
    const key = `${c.country}_${c.platform}_${c.genre_id}_${c.chart}`;
    crawlMap.set(key, c);
  }

  const allAppIds = new Set();
  for (const app of config.apps) {
    allAppIds.add(String(app.id));
    if (app.competitors) {
      for (const cid of app.competitors) allAppIds.add(String(cid));
    }
  }

  // Group by platform → genreId → chart
  const groupings = new Set();
  for (const app of config.apps) {
    const appId = String(app.id);
    const meta = appMetaMap.get(appId);
    const platforms = app.platforms || [];
    const genreId = meta?.primary_genre_id || 0;
    const genreName = meta?.primary_genre_name || "";
    for (const p of platforms) {
      for (const chart of config.charts) {
        groupings.add(JSON.stringify({ platform: p, genre_id: genreId, genre_name: genreName, chart }));
      }
    }
    if (app.competitors) {
      for (const cid of app.competitors) {
        const cMeta = appMetaMap.get(String(cid));
        const cPlatforms = cMeta?.kind === "mac-software" ? ["macos"] : ["ios", "ipados"];
        // Only take platforms allowed by config.platforms
        const allowedCPlatforms = cPlatforms.filter((p) => config.platforms.includes(p));
        const cGenreId = cMeta?.primary_genre_id || 0;
        const cGenreName = cMeta?.primary_genre_name || "";
        for (const cp of allowedCPlatforms) {
          for (const chart of config.charts) {
            groupings.add(JSON.stringify({ platform: cp, genre_id: cGenreId, genre_name: cGenreName, chart }));
          }
        }
      }
    }
  }

  const rows = [];
  for (const gJson of groupings) {
    const g = JSON.parse(gJson);
    for (const appId of allAppIds) {
      const meta = appMetaMap.get(appId);
      // Each app only shows rows for its own primary genre, not other genres
      if (meta && meta.primary_genre_id && meta.primary_genre_id !== g.genre_id) continue;
      const isOurs = ourIds.has(appId);
      const name = meta?.name || appId;

      const countryCells = {};
      for (const cc of allCountries) {
        const key = `${appId}_${cc}_${g.platform}_${g.genre_id}_${g.chart}`;
        const crawlKey = `${cc}_${g.platform}_${g.genre_id}_${g.chart}`;
        const crawl = crawlMap.get(crawlKey);
        const curRank = curRankMap.get(key);
        const prevRank = prevRankMap.get(key);

        if (curRank !== undefined) {
          const delta = prevRank !== undefined ? curRank - prevRank : null;
          countryCells[cc] = { rank: curRank, status: "on_chart", delta };
        } else if (!crawl) {
          // This combination is outside this round's request scope
          countryCells[cc] = { rank: null, status: "not_on_chart", delta: null };
        } else if (crawl.status === "error") {
          countryCells[cc] = { rank: null, status: "crawl_error", delta: null };
        } else if (crawl.status === "ok") {
          // Use this platform's max returned count this round as the threshold, tolerance of 2
          const platMax = platformMaxCount[g.platform] || crawl.requested_limit;
          if (crawl.returned_count < platMax - 2) {
            // This chart returned fewer than the platform max → depth limited
            countryCells[cc] = { rank: null, status: "depth_limited", delta: null };
          } else {
            // Returned count == platform max → chart is complete, genuinely not on chart
            countryCells[cc] = { rank: null, status: "not_on_chart", delta: null };
          }
        }
      }

      rows.push({
        app_id: appId,
        name,
        is_ours: isOurs,
        platform: g.platform,
        genre_id: g.genre_id,
        genre_name: g.genre_name,
        chart: g.chart,
        countries: countryCells,
      });
    }
  }

  const current = {
    generated_at: new Date().toISOString(),
    data_ts: ts,
    platform_max_counts: platformMaxCount,
    rows,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CURRENT_PATH, JSON.stringify(current, null, 2) + "\n");
  log.info(`current.json written`, `rows=${rows.length}`);
}

/**
 * Count the number of each status in current.json.
 */
function summarizeCurrent(rows) {
  const counts = { on_chart: 0, not_on_chart: 0, depth_limited: 0, crawl_error: 0, total: 0 };
  for (const row of rows) {
    for (const cell of Object.values(row.countries)) {
      counts.total++;
      if (counts[cell.status] !== undefined) counts[cell.status]++;
    }
  }
  return counts;
}

/**
 * Main flow: run one round of crawling.
 */
async function runOnce() {
  const ts = alignTs();
  const startTime = Date.now();
  log.info("=== Crawl start ===", `ts=${ts}`);

  // 1. Read config
  const configRaw = await readFile("config/monitor.json", "utf-8");
  const config = JSON.parse(configRaw);
  log.info("Config loaded", `apps=${config.apps.length}, platforms=${config.platforms.join(",")}, categories=${config.categories.join(",")}`);

  // 2. Collect all IDs
  const allIds = new Set();
  for (const app of config.apps) {
    allIds.add(String(app.id));
    if (app.competitors) {
      for (const cid of app.competitors) allIds.add(String(cid));
    }
  }
  log.info(`App IDs to track: ${allIds.size}`, `our=${config.apps.length}, competitors=${allIds.size - config.apps.length}`);

  // 3. Lookup
  const meta = await loadMeta(DATA_DIR);
  let appMetaMap;
  // Check: cache file missing, or date has passed, or new IDs not in cache → re-fetch
  const hasMissingIds = meta && [...allIds].some((id) => !meta.apps[id]);
  if (needsLookup(meta) || hasMissingIds) {
    const reason = !meta ? "first run" : hasMissingIds ? "new IDs detected" : "daily refresh";
    log.info(`Lookup needed (${reason}), fetching ${allIds.size} apps...`);
    appMetaMap = await batchLookup([...allIds]);
    await saveMeta(DATA_DIR, appMetaMap, new Date().toISOString());
    log.info(`Lookup done: ${appMetaMap.size}/${allIds.size} results`);
    for (const id of allIds) {
      if (!appMetaMap.has(id)) {
        log.warn(`Lookup: ID ${id} not found in App Store`);
      }
    }
  } else {
    appMetaMap = new Map(Object.entries(meta.apps));
    log.info(`Lookup cached`, `fetched_at=${meta.fetched_at}, ${appMetaMap.size} apps`);
  }

  // 4. Expand requests + fetch
  const { requests, allIds: allIdSet } = expandRequests(config, appMetaMap);
  log.info(`RSS requests: ${requests.length}`, `countries=${[...new Set(requests.map(r => r.country))].length}, platforms=${[...new Set(requests.map(r => r.platform))].join(",")}, categories=${[...new Set(requests.map(r => r.genreName))].join(",")}`);

  const { crawls, points, platformMaxCount } = await fetchAllRss(requests, allIdSet, ts);

  const okCount = crawls.filter((c) => c.status === "ok").length;
  const errCount = crawls.filter((c) => c.status === "error").length;
  log.info(`RSS results: ${okCount} ok, ${errCount} error, ${points.length} rank points`);

  // Log all failed charts
  for (const c of crawls) {
    if (c.status === "error") {
      log.warn(`Failed board: ${c.country}/${c.platform}/genre=${c.genre_id}`, c.error);
    }
  }

  // 5. Write data
  await appendCrawls(DATA_DIR, crawls);
  const allFailed = crawls.length > 0 && okCount === 0;
  if (!allFailed) {
    await appendPoints(DATA_DIR, points);
    log.info(`Stored: ${crawls.length} crawls, ${points.length} points`);
  } else {
    log.error("100% failure — skipping rank_points write");
  }

  // 6. Generate current.json
  // Previous-round baseline: read yesterday + today's points, excluding points just written this round.
  // (appendPoints already ran above, so we must filter ourselves out by ts,
  //  otherwise prevRank would be this round's rank and delta would always be 0.
  //  Spanning back to yesterday so the first round of each day also has a baseline.)
  const recentPoints = await loadPointsRange(DATA_DIR, yesterdayUTC(), todayUTC());
  const prevPoints = recentPoints.filter((p) => p.ts < ts);
  if (prevPoints.length === 0) {
    log.info("No previous round found — deltas will be null this round");
  }
  await generateCurrent(ts, config, appMetaMap, points, crawls, prevPoints, platformMaxCount);

  // Summary
  const currentRaw = JSON.parse(await readFile(CURRENT_PATH, "utf-8"));
  const summary = summarizeCurrent(currentRaw.rows);
  log.info(`Current summary: on_chart=${summary.on_chart}, not_on_chart=${summary.not_on_chart}, depth_limited=${summary.depth_limited}, crawl_error=${summary.crawl_error}, total=${summary.total}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`=== Crawl complete ===`, `${elapsed}s`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--once")) {
    await runOnce();
    return;
  }

  if (args.includes("--loop")) {
    const intervalIdx = args.indexOf("--interval");
    const interval = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) * 1000 : 3600 * 1000;
    log.info(`Loop mode started`, `interval=${interval / 1000}s`);
    while (true) {
      try {
        await runOnce();
      } catch (err) {
        log.error("Loop iteration error", err.message);
      }
      log.info(`Sleeping ${interval / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // Default: --once
  await runOnce();
}

main().catch((err) => {
  log.error("Fatal error", err.message);
  console.error(err);
  process.exit(1);
});