import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

const LOOKUP_URL = "https://itunes.apple.com/lookup";
const BATCH_SIZE = 100;

/**
 * Batch lookup, at most 100 IDs per batch.
 * Returns Map<appId, appInfo>.
 */
export async function batchLookup(ids) {
  const unique = [...new Set(ids)];
  const result = new Map();
  const batches = Math.ceil(unique.length / BATCH_SIZE);

  log.info(`Lookup: ${unique.length} unique IDs in ${batches} batch(es)`);

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const url = `${LOOKUP_URL}?id=${batch.join(",")}`;
    log.debug(`Lookup batch ${batchNum}/${batches}: ${batch.length} IDs`);

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.error(`Lookup batch ${batchNum} failed: HTTP ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      log.debug(`Lookup batch ${batchNum}: ${data.resultCount} results`);
      if (data.resultCount === 0) continue;
      for (const entry of data.results) {
      const id = String(entry.trackId);
      result.set(id, {
        app_id: id,
        name: entry.trackName || "",
        bundle_id: entry.bundleId || "",
        kind: entry.kind || "",
        primary_genre_id: Number(entry.primaryGenreId) || 0,
        primary_genre_name: entry.primaryGenreName || "",
        genres: entry.genres || [],
        genre_ids: (entry.genreIds || []).map(Number),
        artwork_url: entry.artworkUrl512 || "",
        version: entry.version || "",
        current_version_release_date: entry.currentVersionReleaseDate || "",
        file_size_bytes: Number(entry.fileSizeBytes) || 0,
        price: entry.price || 0,
        formatted_price: entry.formattedPrice || "",
        currency: entry.currency || "",
        average_user_rating: entry.averageUserRating || 0,
        user_rating_count: entry.userRatingCount || 0,
        fetched_at: new Date().toISOString(),
      });
    }
    } catch (err) {
      log.error(`Lookup batch ${batchNum} error`, err.message);
    }
  }
  log.info(`Lookup result: ${result.size}/${unique.length} apps found`);
  return result;
}

/**
 * Check whether a re-lookup is needed:
 * - meta file missing → needed
 * - fetched_at has crossed the UTC day boundary → needed
 */
export function needsLookup(meta) {
  if (!meta || !meta.fetched_at) return true;
  const now = new Date();
  const fetched = new Date(meta.fetched_at);
  return now.toISOString().slice(0, 10) !== fetched.toISOString().slice(0, 10);
}

/**
 * Read the existing meta/apps.json.
 * Returns { apps: {...}, fetched_at: "..." } or null.
 */
export async function loadMeta(dataDir) {
  try {
    const raw = await readFile(join(dataDir, "meta/apps.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save meta/apps.json.
 * meta format: { apps: { [id]: appInfo }, fetched_at: "ISO" }
 */
export async function saveMeta(dataDir, appsMap, fetchedAt) {
  await mkdir(join(dataDir, "meta"), { recursive: true });
  const payload = {
    apps: Object.fromEntries(appsMap),
    fetched_at: fetchedAt,
  };
  await writeFile(join(dataDir, "meta/apps.json"), JSON.stringify(payload, null, 2) + "\n");
}