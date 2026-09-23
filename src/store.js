import { appendFile, readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { log } from "./logger.js";

/**
 * Append one JSONL line to the given path.
 * Creates the parent directory automatically.
 */
async function appendJsonl(filePath, row) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(filePath, JSON.stringify(row) + "\n", "utf-8");
}

/**
 * Append crawls rows.
 */
export async function appendCrawls(dataDir, rows) {
  if (rows.length === 0) return;
  const ts = rows[0].ts;
  const datePath = tsToDatePath(ts);
  const filePath = join(dataDir, "crawls", `${datePath}.jsonl`);
  for (const row of rows) {
    await appendJsonl(filePath, row);
  }
}

/**
 * Append rank_points rows.
 */
export async function appendPoints(dataDir, rows) {
  if (rows.length === 0) return;
  const ts = rows[0].ts;
  const datePath = tsToDatePath(ts);
  const filePath = join(dataDir, "points", `${datePath}.jsonl`);
  for (const row of rows) {
    await appendJsonl(filePath, row);
  }
}

/**
 * Overwrite a single day's rank_daily rows.
 *
 * Difference from appendDaily: the existing rows for that date are dropped
 * first. The rollup is recomputed every hour of the day, so it must be
 * overwritten; otherwise duplicate rows pile up hour by hour.
 */
export async function replaceDaily(dataDir, date, rows) {
  const month = date.slice(0, 7); // "2026-09"
  const filePath = join(dataDir, "rollup", "daily", `${month}.jsonl`);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Read back rows for the other dates in the same month
  const kept = [];
  try {
    const text = await readFile(filePath, "utf-8");
    for (const line of text.trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.date !== date) kept.push(row);
    }
  } catch {
    // File does not exist, start from empty
  }

  const merged = [...kept, ...rows];
  merged.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  await writeFile(filePath, merged.map((r) => JSON.stringify(r)).join("\n") + (merged.length ? "\n" : ""), "utf-8");
}

/**
 * Load the points files for the given date range.
 * fromDate / toDate: "YYYY-MM-DD"
 */
export async function loadPointsRange(dataDir, fromDate, toDate) {
  const rows = [];
  const dates = dateRange(fromDate, toDate);
  for (const d of dates) {
    const datePath = isoToPath(d); // "2026/09/10"
    const filePath = join(dataDir, "points", `${datePath}.jsonl`);
    try {
      const text = await readFile(filePath, "utf-8");
      for (const line of text.trim().split("\n")) {
        if (line) rows.push(JSON.parse(line));
      }
    } catch {
      // File does not exist, skip
    }
  }
  return rows;
}

/**
 * Load the crawls files for the given date range.
 */
export async function loadCrawlsRange(dataDir, fromDate, toDate) {
  const rows = [];
  const dates = dateRange(fromDate, toDate);
  for (const d of dates) {
    const datePath = isoToPath(d);
    const filePath = join(dataDir, "crawls", `${datePath}.jsonl`);
    try {
      const text = await readFile(filePath, "utf-8");
      for (const line of text.trim().split("\n")) {
        if (line) rows.push(JSON.parse(line));
      }
    } catch {
      // File does not exist, skip
    }
  }
  return rows;
}

/**
 * Load the daily rollup for the given months.
 */
export async function loadDailyRange(dataDir, months) {
  const rows = [];
  for (const m of months) {
    const filePath = join(dataDir, "rollup", "daily", `${m}.jsonl`);
    try {
      const text = await readFile(filePath, "utf-8");
      for (const line of text.trim().split("\n")) {
        if (line) rows.push(JSON.parse(line));
      }
    } catch {
      // File does not exist, skip
    }
  }
  return rows;
}

/**
 * List every file path and date under data/points/.
 * Returns [{ path, date: "2026-09-10" }]
 */
export async function listPointFiles(dataDir) {
  return listDatedFiles(dataDir, "points");
}

/**
 * List every file path and date under data/crawls/.
 */
export async function listCrawlFiles(dataDir) {
  return listDatedFiles(dataDir, "crawls");
}

async function listDatedFiles(dataDir, subDir) {
  const files = [];
  const baseDir = join(dataDir, subDir);
  try {
    const years = await readdir(baseDir);
    for (const year of years) {
      const yearDir = join(baseDir, year);
      const yearStat = await stat(yearDir);
      if (!yearStat.isDirectory()) continue;
      const months = await readdir(yearDir);
      for (const month of months) {
        const monthDir = join(yearDir, month);
        const monthStat = await stat(monthDir);
        if (!monthStat.isDirectory()) continue;
        const days = await readdir(monthDir);
        for (const day of days) {
          if (day.endsWith(".jsonl")) {
            const dateStr = day.replace(".jsonl", "");
            files.push({
              path: join(subDir, year, month, day),
              date: `${year}-${month}-${dateStr}`,
            });
          }
        }
      }
    }
  } catch {
    // Directory does not exist
  }
  return files;
}

/**
 * Delete a file (used for cleanup).
 */
export async function deleteFile(dataDir, relPath) {
  const fullPath = join(dataDir, relPath);
  try {
    await unlink(fullPath);
    return true;
  } catch {
    return false;
  }
}

// --- Utility functions ---

function tsToDatePath(ts) {
  // ts format "2026-09-10T03:00:00Z"
  const d = ts.slice(0, 10); // "2026-09-10"
  return isoToPath(d);
}

function isoToPath(isoDate) {
  // "2026-09-10" → "2026/09/10"
  const [y, m, d] = isoDate.split("-");
  return `${y}/${m}/${d}`;
}

function dateRange(from, to) {
  const dates = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}