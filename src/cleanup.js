import { listPointFiles, listCrawlFiles, deleteFile } from "./store.js";

const DATA_DIR = "data";

/**
 * Delete points and crawls files older than N days.
 * Usage: node src/cleanup.js --older-than 90
 *        Defaults to 90 days.
 */
async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--older-than");
  const days = idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 90;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`[cleanup] removing files older than ${cutoffStr} (${days} days)`);

  const pointFiles = await listPointFiles(DATA_DIR);
  const crawlFiles = await listCrawlFiles(DATA_DIR);

  const allFiles = [...pointFiles, ...crawlFiles];
  let deleted = 0;
  let kept = 0;

  for (const file of allFiles) {
    if (file.date < cutoffStr) {
      const ok = await deleteFile(DATA_DIR, file.path);
      if (ok) {
        console.log(`[cleanup] deleted ${file.path} (${file.date})`);
        deleted++;
      }
    } else {
      kept++;
    }
  }

  console.log(`[cleanup] done: ${deleted} deleted, ${kept} kept`);
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});