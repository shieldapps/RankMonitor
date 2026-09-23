import { CHART_PATHS, GENRE_MAP } from "./constants.js";
import { log } from "./logger.js";

const RSS_BASE = "https://itunes.apple.com";
const CONCURRENCY = parseInt(process.env.RSS_CONCURRENCY, 10) || 1;
const INTERVAL_MS = parseInt(process.env.RSS_INTERVAL_MS, 10) || 10000;
const RETRY_DELAY_MS = 2000;
// The Apple RSS API actually returns at most 100 entries per call; 200 is the upper bound
const RSS_LIMIT = 200;

/**
 * Build the RSS URL.
 */
function buildRssUrl(country, platform, genreId, chart) {
  const pathFragment = CHART_PATHS[chart]?.[platform];
  if (!pathFragment) {
    throw new Error(`Unknown chart/platform: ${chart}/${platform}`);
  }
  return `${RSS_BASE}/${country}/rss/${pathFragment}/limit=${RSS_LIMIT}/genre=${genreId}/json`;
}

/**
 * Parse the RSS feed JSON, returning the entry array; order is the rank.
 */
function parseFeed(data) {
  const entries = data?.feed?.entry;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => ({
    rank: index + 1,
    appId: String(entry.id?.attributes?.["im:id"] || ""),
    name: entry["im:name"]?.label || "",
  }));
}

/**
 * A single RSS request (with retry).
 */
async function fetchOneRss(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        log.warn(`RSS attempt ${attempt + 1}/2 failed: ${label}`, lastError);
        if (attempt === 0) await sleep(RETRY_DELAY_MS);
        continue;
      }
      const data = await resp.json();
      const entries = parseFeed(data);
      log.debug(`RSS ok: ${label}`, `entries=${entries.length}`);
      return { ok: true, entries, entryCount: entries.length };
    } catch (err) {
      lastError = err.message;
      log.warn(`RSS attempt ${attempt + 1}/2 error: ${label}`, lastError);
      if (attempt === 0) await sleep(RETRY_DELAY_MS);
    }
  }
  log.error(`RSS failed: ${label}`, lastError);
  return { ok: false, error: lastError };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect all (country, platform, genreId, chart) combinations that need a request.
 */
export function expandRequests(config, appMetaMap) {
  const { countries, charts, platforms: globalPlatforms, categories: globalCategories, apps } = config;
  const allCountries = [...countries.core, ...countries.secondary];

  const ourIds = new Set();
  const allIds = new Set();
  for (const app of apps) {
    ourIds.add(String(app.id));
    allIds.add(String(app.id));
    if (app.competitors) {
      for (const cid of app.competitors) {
        // Competitors are not our apps, but dedupe/ignore if our own ID was entered by mistake
        allIds.add(String(cid));
      }
    }
  }

  const platformSet = new Set(globalPlatforms);
  const genreNameSet = new Set(globalCategories);
  for (const app of apps) {
    if (app.platforms) {
      for (const p of app.platforms) platformSet.add(p);
    } else {
      const meta = appMetaMap.get(String(app.id));
      if (meta) {
        for (const p of inferPlatformsFromKind(meta.kind)) platformSet.add(p);
      }
    }
  }

  const platforms = [...platformSet];
  const genreNames = [...genreNameSet];

  const requests = [];
  for (const cc of allCountries) {
    for (const platform of platforms) {
      for (const genreName of genreNames) {
        const genreId = GENRE_MAP[genreName];
        if (!genreId) continue;
        for (const chart of charts) {
          requests.push({ country: cc, platform, genreName, genreId, chart });
        }
      }
    }
  }
  return { requests, ourIds, allIds };
}

function inferPlatformsFromKind(kind) {
  if (kind === "mac-software") return ["macos"];
  return ["ios", "ipados"];
}

/**
 * Fetch all RSS charts concurrently.
 * Returns { crawls, points, platformMaxCount }.
 * platformMaxCount: max entries returned per platform this round, used to detect depth limited.
 */
export async function fetchAllRss(requests, allIds, ts) {
  const crawls = [];
  const points = [];

  const queue = [...requests];
  const total = queue.length;

  log.info(`RSS fetch start: ${total} requests, concurrency=${CONCURRENCY}`);

  let completed = 0;
  let okCount = 0;
  let errCount = 0;

  async function worker() {
    while (queue.length > 0) {
      const req = queue.shift();
      const label = `${req.country}/${req.platform}/${req.genreName}/${req.chart}`;
      const url = buildRssUrl(req.country, req.platform, req.genreId, req.chart);
      const result = await fetchOneRss(url, label);

      await sleep(INTERVAL_MS);
      completed++;

      const crawlRow = {
        ts,
        country: req.country,
        platform: req.platform,
        genre_id: req.genreId,
        chart: req.chart,
        status: result.ok ? "ok" : "error",
        requested_limit: RSS_LIMIT,
        returned_count: result.ok ? result.entryCount : 0,
        error: result.ok ? null : result.error,
      };
      crawls.push(crawlRow);

      if (result.ok) {
        okCount++;
        let hitCount = 0;
        for (const entry of result.entries) {
          if (allIds.has(entry.appId)) {
            points.push({
              ts,
              country: req.country,
              platform: req.platform,
              genre_id: req.genreId,
              chart: req.chart,
              app_id: entry.appId,
              rank: entry.rank,
              name_at_time: entry.name,
            });
            hitCount++;
          }
        }
        if (hitCount > 0) {
          log.debug(`Hits: ${label}`, `${hitCount} app(s) found`);
        }
      } else {
        errCount++;
      }

      if (completed % 10 === 0 || completed === total) {
        log.info(`RSS progress: ${completed}/${total} (${okCount} ok, ${errCount} error, ${points.length} points)`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Compute the max returned entries per platform this round (for depth-limited detection)
  const platformMaxCount = {};
  for (const c of crawls) {
    if (c.status === "ok") {
      if (!platformMaxCount[c.platform] || c.returned_count > platformMaxCount[c.platform]) {
        platformMaxCount[c.platform] = c.returned_count;
      }
    }
  }

  log.info(`RSS fetch done: ${okCount} ok, ${errCount} error, ${points.length} points`);
  for (const [plat, max] of Object.entries(platformMaxCount)) {
    log.info(`Platform max returned: ${plat} = ${max}`);
  }

  return { crawls, points, platformMaxCount };
}