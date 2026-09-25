import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadPointsRange, loadCrawlsRange, loadDailyRange } from "./store.js";
import { buildSeries, bucketRange, indexCrawls } from "./series.js";

const DATA_DIR = "data";
const CURRENT_PATH = join(DATA_DIR, "current.json");
const PUBLIC_DIR = "public";

const COUNTRY_NAMES = {
  us: "United States", gb: "United Kingdom", ca: "Canada", au: "Australia", de: "Germany", fr: "France", jp: "Japan",
  in: "India", br: "Brazil", nz: "New Zealand", nl: "Netherlands", pt: "Portugal", se: "Sweden",
  ch: "Switzerland", es: "Spain", tw: "Taiwan", mx: "Mexico",
  it: "Italy", be: "Belgium", hk: "Hong Kong", sg: "Singapore", za: "South Africa",
};

/**
 * Time range presets.
 *
 * days     — lookback days (including today)
 * granHours— bucket width (hours)
 * source   — points: hourly raw data; daily: rollup daily aggregate
 * tick     — x-axis label format
 *
 * Why two data sources: cleanup only keeps 90 days of points/crawls,
 * older history survives only in rollup/daily (per-day, median/best/worst only).
 * So ≤7 days uses points (keeps hourly detail), ≥30 days uses daily.
 */
const RANGES = [
  { key: "1d", label: "Today", days: 1, granHours: 1, source: "points", tick: "time" },
  { key: "3d", label: "3 days", days: 3, granHours: 1, source: "points", tick: "datetime" },
  { key: "1w", label: "1 week", days: 7, granHours: 6, source: "points", tick: "datetime" },
  { key: "1m", label: "1 month", days: 30, granHours: 24, source: "daily", tick: "date" },
  { key: "3m", label: "3 months", days: 90, granHours: 24, source: "daily", tick: "date" },
  { key: "6m", label: "6 months", days: 180, granHours: 24, source: "daily", tick: "date" },
  { key: "1y", label: "1 year", days: 365, granHours: 24, source: "daily", tick: "date" },
];

/** Lookback days needed by the fine-grained source (longest 7-day preset). */
const POINTS_LOOKBACK_DAYS = 7;

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** List every "YYYY-MM" month covered by from~to. */
function monthList(fromDate, toDate) {
  const months = [];
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ty, tm] = toDate.split("-").map(Number);
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/**
 * Build chart series for all 7 presets.
 *
 * Key constraint: the dashboard runs on GitHub Actions and a user switching
 * ranges can never trigger CI, so every preset must be computed at build time
 * and embedded in the HTML; the frontend switch is a purely local redraw.
 */
async function buildHistory(current) {
  const today = isoDay(0);
  const ourRows = current.rows.filter((r) => r.is_ours);
  if (ourRows.length === 0) {
    return { ranges: RANGES, apps: [], countries: [], buckets: {}, series: {}, cells: {} };
  }

  // Fine-grained source: last 7 days of points + crawls
  const points = await loadPointsRange(DATA_DIR, isoDay(-(POINTS_LOOKBACK_DAYS - 1)), today);
  const crawls = await loadCrawlsRange(DATA_DIR, isoDay(-(POINTS_LOOKBACK_DAYS - 1)), today);
  const crawlIndex = indexCrawls(crawls);

  // Coarse-grained source: every monthly rollup file covering the longest preset
  const longestDays = Math.max(...RANGES.map((r) => r.days));
  const dailyRows = await loadDailyRange(DATA_DIR, monthList(isoDay(-(longestDays - 1)), today));
  // "Did a crawl actually run that day" test: does any rollup row anywhere land on it
  const observedDates = new Set(dailyRows.map((r) => r.date));

  const apps = ourRows.map((r) => ({
    k: `${r.app_id}|${r.platform}|${r.genre_id}|${r.chart}`,
    id: r.app_id,
    name: r.name,
    genre: r.genre_name,
    genreId: r.genre_id,
    chart: r.chart,
    platform: r.platform,
  }));

  const allCountries = [...new Set(ourRows.flatMap((r) => Object.keys(r.countries)))];

  const buckets = {};
  const series = {};
  let emitted = 0;

  for (const range of RANGES) {
    const fromDate = isoDay(-(range.days - 1));
    const bk = bucketRange(fromDate, today, range.granHours);
    buckets[range.key] = bk;

    for (const app of apps) {
      for (const cc of allCountries) {
        const s = buildSeries({
          granularity: range.source,
          granHours: range.granHours,
          points,
          crawlIndex,
          dailyRows,
          observedDates,
          appId: app.id,
          country: cc,
          platform: app.platform,
          genreId: app.genreId,
          chart: app.chart,
          buckets: bk,
        });

        // Drop a series with zero observations entirely — secondary countries
        // are usually never on the chart; keeping them bloats the payload several-fold.
        if (s.stats.observedBuckets === 0) continue;

        // Flattened encoding: 0 as the null sentinel (rank is always ≥1), saves 4 bytes per null
        const vals = s.values.map((v) => v || 0);
        const spans = s.showSpans ? s.spans.flatMap((sp) => (sp ? sp : [0, 0])) : [];
        const gaps = s.gaps.flat();
        const st = s.stats;

        series[`${range.key}|${app.k}|${cc}`] = [
          vals,
          spans,
          gaps,
          [st.onChartBuckets, st.observedBuckets, st.best || 0, st.worst || 0, st.median || 0, st.samples],
        ];
        emitted++;
      }
    }
  }

  // Current snapshot used by the top stat tiles
  const cells = {};
  for (const r of ourRows) {
    const k = `${r.app_id}|${r.platform}|${r.genre_id}|${r.chart}`;
    for (const cc of allCountries) {
      const cell = r.countries[cc];
      if (!cell) continue;
      cells[`${k}|${cc}`] = [
        cell.status === "on_chart" ? cell.rank : 0,
        cell.delta === null || cell.delta === undefined ? null : cell.delta,
        cell.status,
      ];
    }
  }

  console.log(`[dashboard] history: ${emitted} series across ${RANGES.length} ranges`);
  return { ranges: RANGES, apps, countries: allCountries, buckets, series, cells };
}

async function main() {
  let current, config;
  try {
    current = JSON.parse(await readFile(CURRENT_PATH, "utf-8"));
  } catch { console.error("[dashboard] current.json not found"); process.exit(1); }
  try {
    config = JSON.parse(await readFile("config/monitor.json", "utf-8"));
  } catch { console.error("[dashboard] config/monitor.json not found"); process.exit(1); }

  let appIcons = {};
  try {
    const meta = JSON.parse(await readFile(join(DATA_DIR, "meta/apps.json"), "utf-8"));
    for (const [id, info] of Object.entries(meta.apps || {})) {
      appIcons[id] = info.artwork_url || "";
    }
  } catch {}

  const history = await buildHistory(current);
  const html = generateHtml(current, config, appIcons, history);
  if (!existsSync(PUBLIC_DIR)) await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(join(PUBLIC_DIR, "index.html"), html, "utf-8");
  console.log("[dashboard] public/index.html generated");
}

function generateHtml(current, config, appIcons, history) {
  const { rows, data_ts, generated_at } = current;

	// UTC ISO → display string
	function utcStr(iso) {
	  return new Date(iso).toISOString().replace(/\.\d+Z/, "").replace("T", " ").concat(" UTC");
	}
  const coreCountries = config.countries.core;
  const allCountries = [...coreCountries, ...config.countries.secondary];

  // Index by app_id
  const rowMap = new Map();
  for (const r of rows) {
    if (!rowMap.has(r.app_id)) rowMap.set(r.app_id, { name: r.name, rows: [] });
    rowMap.get(r.app_id).rows.push(r);
  }

  const sl = { not_on_chart: "Off chart", depth_limited: "Depth shortage", crawl_error: "Crawl failed" };
  const sc = { on_chart: "h", not_on_chart: "off", depth_limited: "lim", crawl_error: "err" };

  // ---- Render one section = our App + its competitors ----
  function renderSection(appConf, idx) {
    const ourId = String(appConf.id);
    const our = rowMap.get(ourId);
    if (!our) return "";

    const competitorIds = (appConf.competitors || []).map(String);
    const allRows = [];

    for (const r of our.rows) allRows.push({ ...r, _isOurs: true, _appId: ourId });
    for (const cid of competitorIds) {
      const comp = rowMap.get(cid);
      if (!comp) continue;
      for (const r of comp.rows) allRows.push({ ...r, _isOurs: false, _appId: cid });
    }

    // Dedupe: take the first row for an appId under the same platform+genre_name
    const deduped = [];
    const seen = new Set();
    for (const r of allRows) {
      const key = `${r._appId}|${r.platform}|${r.genre_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    let html = `<div class="section"><h3>&#167;${idx + 1} ${esc(our.name)}</h3>`;
    html += `<div class="tblscroll"><table class="tbl"><thead><tr><th class="c-app">App</th><th class="c-cat">Category</th>`;
    for (const cc of allCountries) {
      // Storefront code only - the full name made every header wrap. The name is
      // still reachable: title serves desktop hover, data-cc feeds the tap
      // handler for touch devices, which have no hover at all.
      const ccName = COUNTRY_NAMES[cc] || cc.toUpperCase();
      html += `<th class="${coreCountries.includes(cc) ? "core" : "sec"}" data-cc="${cc}" title="${esc(ccName)}">${cc.toUpperCase()}</th>`;
    }
    html += `</tr></thead><tbody>`;

    let prevAppId = "";
    for (const r of deduped) {
      const isFirstOfApp = r._appId !== prevAppId;
      prevAppId = r._appId;
      const info = rowMap.get(r._appId);
      const icon = appIcons[r._appId] || "";

      html += `<tr>`;
      if (isFirstOfApp) {
        html += `<td class="c-app" rowspan="${deduped.filter((x) => x._appId === r._appId).length}">`;
        html += `<div class="c-appinner">`;
        if (icon) html += `<img class="icon" src="${esc(icon)}" width="32" height="32" loading="lazy" onerror="this.style.display='none'">`;
        html += `<a class="aname" href="https://apps.apple.com/app/id${esc(r._appId)}" target="_blank" rel="noopener">${esc(info.name)}</a>`;
        html += `</div>`;
        html += `</td>`;
      }
      html += `<td class="c-cat">${esc(r.genre_name)}</td>`;
      for (const cc of allCountries) {
        // Mirrors the <th class="core|sec"> above; the narrow-screen rule hides
        // .cc-sec cells to fold the 14 secondary storefronts away.
        const ccCls = coreCountries.includes(cc) ? "cc-core" : "cc-sec";
        const cell = r.countries[cc];
        if (!cell) { html += `<td class="na ${ccCls}">-</td>`; continue; }
        if (cell.status === "on_chart") {
          let d = "";
          // delta > 0 means the rank number grew = rank dropped
          if (cell.delta > 0) d = `<span class="dn">&#9660;${cell.delta}</span>`;
          else if (cell.delta < 0) d = `<span class="up">&#9650;${Math.abs(cell.delta)}</span>`;
          html += `<td class="h ${ccCls}">#${cell.rank} ${d}</td>`;
        } else {
          html += `<td class="${sc[cell.status]} ${ccCls}">${sl[cell.status] || "?"}</td>`;
        }
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
    return html;
  }

  const chartData = JSON.stringify({
    ts: data_ts,
    apps: history.apps,
    countries: history.countries,
    countryNames: COUNTRY_NAMES,
    ranges: history.ranges,
    buckets: history.buckets,
    series: history.series,
    cells: history.cells,
  });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>App Store Rank Monitor</title>
<script>
// Set the theme as early as possible to avoid a white flash
(function(){try{var t=localStorage.getItem('rm-theme');
if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
<\/script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"><\/script>
<style>
:root{
  color-scheme:light;
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --good-ink:#006300; --bad-ink:#b02a2a; --lim-ink:#9c4f22;
  --critical:#d03b3b; --serious:#ec835a;
  --chip-good-bg:rgba(12,163,12,.10); --chip-bad-bg:rgba(208,59,59,.10);
  --wash:rgba(11,11,11,.04);
  /* Opaque twin of --wash. Sticky cells slide over other content, so a
     translucent background would let the text underneath show through. */
  --wash-solid:#f2f2f0;
  /* Frozen matrix columns. --catcol's sticky offset is --appcol, so both must
     stay in sync; changing them here is the only place to change them. */
  --appcol:210px; --catcol:110px;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --good-ink:#0ca30c; --bad-ink:#e66767; --lim-ink:#ec835a;
  --critical:#d03b3b; --serious:#ec835a;
  --chip-good-bg:rgba(12,163,12,.16); --chip-bad-bg:rgba(208,59,59,.18);
  --wash:rgba(255,255,255,.05);
  --wash-solid:#242423;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--plane);color:var(--ink);-webkit-font-smoothing:antialiased;
  /* env() keeps content clear of the iPhone notch and home indicator; it is 0 elsewhere */
  padding:calc(24px + env(safe-area-inset-top)) calc(32px + env(safe-area-inset-right))
          calc(24px + env(safe-area-inset-bottom)) calc(32px + env(safe-area-inset-left))}
h1{font-size:22px;margin-bottom:4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}

.card{background:var(--surface-1);border-radius:12px;padding:16px 20px;margin-bottom:20px;
  box-shadow:0 1px 2px var(--border);border:1px solid var(--border)}
.card h3{font-size:16px;margin-bottom:12px;color:var(--ink)}

/* ---- Filter row: scoped to the whole chart card (the matrix table below uses a separate snapshot basis) ---- */
.filters{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.fgroup{display:flex;align-items:center;gap:8px}
.flabel{font-size:12px;color:var(--muted)}
select{padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;
  background:var(--surface-1);color:var(--ink);max-width:280px}
.seg{display:inline-flex;background:var(--wash);border-radius:8px;padding:2px;gap:2px}
.seg button{border:0;background:transparent;color:var(--ink-2);font-size:13px;
  padding:5px 11px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
.seg button:hover{color:var(--ink)}
.seg button[aria-pressed="true"]{background:var(--surface-1);color:var(--ink);font-weight:600;
  box-shadow:0 1px 2px var(--border)}
.seg button:focus-visible,select:focus-visible,summary:focus-visible,.themebtn:focus-visible{
  outline:2px solid var(--series-1);outline-offset:1px}

.themebtn{border:1px solid var(--border);background:var(--surface-1);color:var(--ink-2);
  border-radius:7px;padding:6px 11px;font-size:12px;cursor:pointer;font-family:inherit}

/* ---- Stat tiles ---- */
.tiles{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.tile{flex:1 1 130px;min-width:130px;padding:10px 12px;border-radius:9px;background:var(--wash)}
.tile .k{font-size:11px;color:var(--muted);margin-bottom:3px}
.tile .v{font-size:22px;font-weight:600;line-height:1.15;letter-spacing:-.02em}
.tile .v small{font-size:12px;font-weight:500;color:var(--muted);margin-left:3px}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:6px;
  margin-left:6px;vertical-align:middle}
.chip.up{color:var(--good-ink);background:var(--chip-good-bg)}
.chip.dn{color:var(--bad-ink);background:var(--chip-bad-bg)}
.chip.flat{color:var(--muted);background:var(--wash)}

.chart-box{width:100%;height:340px;position:relative}
.empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  text-align:center;color:var(--muted);font-size:13px;line-height:1.7;padding:0 24px}
.empty.on{display:flex}

.leg{display:flex;gap:16px;font-size:12px;color:var(--ink-2);margin-top:10px;flex-wrap:wrap}
.leg-item{display:flex;align-items:center;gap:5px}
.leg-mark{width:11px;height:11px;display:inline-block;flex:0 0 auto}
.leg-line{width:16px;height:3px;border-radius:2px;display:inline-block}

details.tblview{margin-top:12px;border-top:1px solid var(--border);padding-top:10px}
details.tblview summary{cursor:pointer;font-size:12px;color:var(--ink-2);list-style:none}
details.tblview summary::-webkit-details-marker{display:none}
details.tblview summary::before{content:"▸ "}
details.tblview[open] summary::before{content:"▾ "}
.tblwrap{max-height:320px;overflow:auto;-webkit-overflow-scrolling:touch;margin-top:10px}
table.mini{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
table.mini th,table.mini td{padding:5px 8px;text-align:left;border-bottom:1px solid var(--border)}
table.mini th{position:sticky;top:0;background:var(--surface-1);color:var(--muted);font-weight:600;font-size:11px}
table.mini td.num{font-weight:600}

/* ---- Matrix table ---- */
.section{background:var(--surface-1);border-radius:12px;padding:16px 20px;margin-bottom:16px;
  box-shadow:0 1px 2px var(--border);border:1px solid var(--border)}
/* Horizontal scroll container. Without this the 22-column matrix was clipped
   outright — the right-hand countries were unreachable, not merely off-screen.
   This also fixes the same clipping on desktop. */
.tblscroll{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
/* border-collapse:separate (with 0 spacing) is required for position:sticky to
   work on table cells; collapsed borders belong to the table, not the cell. */
.tbl{border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%}
.tbl th,.tbl td{padding:7px 8px;text-align:center;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl th{background:var(--wash-solid);font-weight:600;color:var(--ink-2);font-size:11px}
.tbl th.core{color:var(--ink)}
.tbl th.sec{color:var(--muted)}
/* Opaque cells: a sticky column slides over its neighbours and would otherwise
   show their text through a translucent background. */
.tbl td{font-variant-numeric:tabular-nums;white-space:nowrap;background:var(--surface-1)}

/* Frozen first two columns. A sticky column needs a definite left edge, which
   is why .c-app and .c-cat are fixed-width rather than min-width. They carry the
   full .tbl th/.tbl td specificity so their text-align:left actually wins over
   the centred cells above - and overflow:hidden, because a cell that is pinned to
   a fixed width can no longer grow to fit a long app name. Without it the name
   escapes the cell and the sticky Category column paints over the overflow,
   which reads as stray text sitting inside the country columns. */
.tbl th.c-app,.tbl td.c-app{text-align:left;width:var(--appcol);min-width:var(--appcol);max-width:var(--appcol);overflow:hidden;position:sticky;left:0;z-index:2}
/* The second frozen column's offset is the first column's width — hence the
   shared variable, so a breakpoint cannot desynchronise the two. */
.tbl th.c-cat,.tbl td.c-cat{text-align:left;width:var(--catcol);min-width:var(--catcol);max-width:var(--catcol);overflow:hidden;text-overflow:ellipsis;font-weight:500;position:sticky;left:var(--appcol);z-index:2;border-right:1px solid var(--border)}
.tbl thead th.c-app,.tbl thead th.c-cat{z-index:3}
/* Country columns: wide enough for "#46 ▼3" without wrapping */
.tbl th.core,.tbl th.sec,.tbl td.cc-core,.tbl td.cc-sec{min-width:64px}
.icon{border-radius:0;background:var(--wash);object-fit:cover;vertical-align:middle;flex:0 0 auto}
/* Icon and name on one row. The name is the only item allowed to shrink, so a
   long one ellipsises inside the fixed-width column instead of escaping it. */
.c-appinner{display:flex;align-items:center;gap:8px;min-width:0}
.tbl td.c-app .aname{min-width:0;overflow:hidden;text-overflow:ellipsis}
.aname{font-size:14px;font-weight:600;color:var(--series-1);text-decoration:none}
.aname:hover{text-decoration:underline}

.h{color:var(--good-ink);font-weight:600}
.off{color:var(--bad-ink)}
.lim{color:var(--lim-ink);font-style:italic}
.err{color:var(--muted)}
.na{color:var(--muted);opacity:.5}
.dn{color:var(--bad-ink);font-size:10px;margin-left:2px}
.up{color:var(--good-ink);font-size:10px;margin-left:2px}

/* ---- Country visibility toggle: only useful where the matrix is cramped ---- */
.sechead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.sechead h2{font-size:15px;font-weight:600}
.ccbtn{display:none;border:1px solid var(--border);background:var(--surface-1);color:var(--ink-2);
  border-radius:7px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.ccbtn:hover{color:var(--ink)}
.ccbtn:focus-visible{outline:2px solid var(--series-1);outline-offset:1px}
/* Country-code reveal. Touch devices have no hover, so a code-only header would
   be a dead end on a phone; tapping a header shows the full name here instead.
   Fixed positioning keeps it clear of .tblscroll's overflow clipping, which
   would otherwise cut the bubble off at the first and last columns. */
.ccpop{position:fixed;z-index:20;display:none;padding:6px 10px;border-radius:8px;
  background:var(--ink);color:var(--plane);font-size:12px;font-weight:500;
  white-space:nowrap;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.ccpop.on{display:block}

@media (max-width:720px){
  body{padding:calc(14px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right))
              calc(14px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left))}
  h1{font-size:19px}
  .card,.section{padding:13px 14px;border-radius:10px}
  .chart-box{height:260px}

  /* Filters stack full-width; the range control scrolls sideways rather than
     overflowing the viewport. */
  .filters{gap:10px}
  .fgroup{width:100%}
  .fgroup .flabel{flex:0 0 auto}
  select{flex:1;max-width:none;min-height:44px;font-size:16px} /* 16px avoids iOS zoom-on-focus */
  .seg{overflow-x:auto;max-width:100%;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  .seg::-webkit-scrollbar{display:none}
  .seg button{flex:0 0 auto;min-height:40px;padding:8px 13px}
  .themebtn{min-height:40px}

  /* Secondary countries fold away behind the toggle */
  body:not(.showall) .tbl .cc-sec{display:none}
  .ccbtn{display:inline-block;min-height:40px}

  .tile{flex:1 1 calc(50% - 5px);min-width:0}
  .tile .v{font-size:20px}
  .tblwrap{max-height:260px}
}

@media (max-width:480px){
  .tbl{font-size:12px}
  :root{--appcol:160px;--catcol:84px}
  .tbl th,.tbl td{padding:6px 6px}
  .tbl th.core,.tbl th.sec,.tbl td.cc-core,.tbl td.cc-sec{min-width:56px}
  .tile .v{font-size:19px}
}
</style></head><body>
<div class="top">
<div>
<h1>App Store Rank Monitor</h1>
<p class="sub">Data time: ${utcStr(data_ts)} · Generated: ${utcStr(generated_at)} · &#9660; Rank down &#9650; Rank up</p>
</div>
<button class="themebtn" id="theme" type="button">Toggle theme</button>
</div>

<div class="card">
  <div class="filters">
    <div class="fgroup">
      <span class="flabel">Time range</span>
      <div class="seg" id="ranges" role="group" aria-label="Time range"></div>
    </div>
    <div class="fgroup"><span class="flabel">App</span><select id="ca" aria-label="App"></select></div>
    <div class="fgroup"><span class="flabel">Country</span><select id="cc" aria-label="Country"></select></div>
  </div>

  <div class="tiles" id="tiles"></div>

  <div class="chart-box">
    <div id="cb" style="width:100%;height:100%"></div>
    <div class="empty" id="empty"></div>
  </div>

  <div class="leg" id="leg"></div>

  <details class="tblview">
    <summary>Table view (exact values for each sample point)</summary>
    <div class="tblwrap" id="tblwrap"></div>
  </details>
</div>

<div class="sechead">
  <h2>Country matrix &mdash; each App against its competitors</h2>
  <button class="ccbtn" id="ccbtn" type="button" aria-pressed="false">Show all ${allCountries.length} countries</button>
</div>
${config.apps.map((a, i) => renderSection(a, i)).join("\n")}

<div class="ccpop" id="ccpop" role="status" aria-live="polite"></div>

<script>
const D = ${chartData};

// Status code → display info. Shape acts as a second encoding channel independent of color.
const GAP_NAME = { 1:'Off chart', 2:'Depth shortage', 3:'Crawl failed' };
const GAP_SVG  = {
  1:'<svg viewBox="0 0 12 12" width="11" height="11"><rect x="6" y="1.2" width="6.8" height="6.8" transform="rotate(45 6 1.2)" fill="currentColor"/></svg>',
  2:'<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 1.6 11 10.4H1z" fill="currentColor"/></svg>',
  3:'<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};
const SYM = { 1:'diamond', 2:'triangle', 3:'cross' };

const $ = (id) => document.getElementById(id);
const appSel = $('ca'), ccSel = $('cc');
let curRange = D.ranges[0].key;

// ---- Read the tokens for the current theme, for ECharts to use ----
function tokens(){
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    series: g('--series-1'), critical: g('--critical'), serious: g('--serious'),
    muted: g('--muted'), grid: g('--grid'), axis: g('--axis'),
    ink: g('--ink'), ink2: g('--ink-2'), surface: g('--surface-1'),
  };
}

// ---- Fill the dropdowns ----
D.apps.forEach((a, i) => {
  const o = document.createElement('option');
  o.value = a.k;                                  // app_id|platform|genre_id|chart
  o.textContent = a.name + ' · ' + a.genre;
  appSel.appendChild(o);
});

D.countries.forEach((cc) => {
  const o = document.createElement('option');
  o.value = cc;
  o.textContent = cc.toUpperCase();
  ccSel.appendChild(o);
});

// Default country: prefer us
if (D.countries.includes('us')) ccSel.value = 'us';

// Default App: prefer the one that has historical data in the current country, not simply the first
(function pickDefaultApp(){
  for (let i = 0; i < appSel.options.length; i++) {
    const k = appSel.options[i].value;
    for (const r of D.ranges) {
      if (D.series[r.key + '|' + k + '|' + ccSel.value]) { appSel.selectedIndex = i; return; }
    }
  }
})();

// ---- Time range segmented control ----
const rangeBox = $('ranges');
D.ranges.forEach((r) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = r.label;
  b.dataset.k = r.key;
  b.setAttribute('aria-pressed', String(r.key === curRange));
  b.addEventListener('click', () => {
    curRange = r.key;
    [...rangeBox.children].forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.k === curRange)));
    render();
  });
  rangeBox.appendChild(b);
});

// UTC ISO → Date. Kept as a single place to change how stored timestamps are
// rendered, so the axis, the tooltip and the table always agree.
function utcDate(iso){
  return new Date(iso);
}

// ---- Axis label formatting ----
function fmtTick(iso, mode){
  const d = utcDate(iso);
  const hm = String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  const md = String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  if (mode === "time") return hm;
  if (mode === "datetime") return md + " " + hm;
  return md;
}

// Full timestamp used in the tooltip and the table (UTC)
function fmtFull(iso){
  const d = utcDate(iso);
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}


// Pick a tidy tick step: 1/2/5/10/20/50/100…
function niceStep(raw){
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mult * mag;
}

const ch = echarts.init($('cb'), null, { renderer: 'canvas' });

function render(){
  const range = D.ranges.find((r) => r.key === curRange);
  const ak = appSel.value, cc = ccSel.value;
  const key = curRange + '|' + ak + '|' + cc;
  const raw = D.series[key];
  const app = D.apps.find((a) => a.k === ak);

  const emptyEl = $('empty');

  if (!raw) {
    ch.clear();
    emptyEl.classList.add('on');
    emptyEl.textContent = range.label + ' · ' + (D.countryNames[cc] || cc).concat('')
      + ' has no crawl records in this range for ' + (app ? app.name : 'this App') + '.'
      + 'Try another country or range.';
    $('tiles').innerHTML = '';
    $('leg').innerHTML = '';
    $('tblwrap').innerHTML = '';
    return;
  }
  emptyEl.classList.remove('on');

  const [vals0, spans0, gapsFlat, st] = raw;
  const labels = D.buckets[curRange];
  const T = tokens();
  const narrow = mqNarrow.matches;

  // 0 is the null sentinel → restore it to null so the line breaks instead of connecting to 0
  const vals = vals0.map((v) => (v > 0 ? v : null));
  const ranks = vals0.filter((v) => v > 0);
  const maxRank = ranks.length ? Math.max(...ranks) : 100;
  const minRank = ranks.length ? Math.min(...ranks) : 1;

  // Trim the y-axis to the data (absolute ticks are meaningless on a rank chart).
  // Use tidily stepped ticks, otherwise ECharts squeezes in an extra tick at min
  // (we once saw uneven sequences like 26,27,30,33,36,39).
  // The largest slot is reserved for the "no rank" placeholder row.
  const dataSpan = Math.max(maxRank - minRank, 3);
  const step = niceStep(dataSpan / 4);
  const lo = Math.max(1, Math.floor((minRank - dataSpan * 0.1) / step) * step);
  const hiRank = Math.ceil((maxRank + dataSpan * 0.1) / step) * step;
  const axisMax = hiRank + step;

  // Gap index → status code
  const gapMap = new Map();
  for (let i = 0; i < gapsFlat.length; i += 2) gapMap.set(gapsFlat[i], gapsFlat[i + 1]);

  // Decide per point whether to draw a marker.
  //
  // We cannot use a blunt density rule like "few buckets → draw markers, many buckets → don't":
  // when data is sparse (say 15 of 72 buckets have values and none are adjacent),
  // the line segments cannot be drawn and the markers are switched off, so the whole
  // curve shrinks to a tiny stretch — a dozen data points vanish into thin air.
  //
  // The correct criterion is "does this point have a neighbour it can connect to":
  // points that connect are expressed by the line itself and need no extra marker;
  // isolated points have no line to lean on and must be drawn as markers to be visible.
  const pointData = vals.map((v, i) => {
    if (v === null) return null;
    const hasPrev = i > 0 && vals[i - 1] !== null;
    const hasNext = i < vals.length - 1 && vals[i + 1] !== null;
    return hasPrev || hasNext ? { value: v, symbol: 'none' } : v;
  });

  const lineColor = T.series;

  const series = [];

  // Fluctuation band (only when a bucket holds more than one sample)
  if (spans0.length) {
    const sdata = [];
    for (let i = 0; i < labels.length; i++) {
      const a = spans0[i * 2], b = spans0[i * 2 + 1];
      if (a > 0 && b > 0) sdata.push([i, a, b]);
    }
    if (sdata.length) {
      series.push({
        name: 'Fluctuation band (best~worst)',
        type: 'custom',
        z: 1,
        legendHoverLink: false,
        itemStyle: { color: lineColor },
        tooltip: { show: false },
        renderItem: (params, api) => {
          const x = api.coord([api.value(0), 0])[0];
          const p1 = api.coord([api.value(0), api.value(1)]);
          const p2 = api.coord([api.value(0), api.value(2)]);
          const bandW = api.size([1, 0])[0];
          // Leave a 2px gap then take 60%, so adjacent bucket band blocks have room to breathe
          const half = Math.max(1.5, (bandW - 2) * 0.3);
          const top = Math.min(p1[1], p2[1]);
          const h = Math.max(2, Math.abs(p2[1] - p1[1]));
          return {
            type: 'rect',
            shape: { x: x - half, y: top, width: half * 2, height: h },
            style: { fill: lineColor, opacity: 0.12 },
          };
        },
        data: sdata,
      });
    }
  }

  // Main line
  series.push({
    name: 'Rank',
    type: 'line',
    z: 3,
    data: pointData,
    connectNulls: false,
    showSymbol: true,
    symbol: 'circle',
    symbolSize: narrow ? (labels.length <= 120 ? 8 : 6) : (labels.length <= 120 ? 7 : 5),
    lineStyle: { width: 2, color: lineColor },
    itemStyle: { color: lineColor, borderWidth: 2, borderColor: T.surface },
    // Do not use focus:'series' —— that fades the gap markers, which are exactly what you compare against when reading this line
    emphasis: { scale: 1.4 },
    markLine: gapMap.size ? {
      silent: true,
      symbol: 'none',
      lineStyle: { color: T.axis, width: 1, type: 'solid' },
      // 'end' sits outside the plot and would clip against the narrow right margin
      label: { formatter: 'No rank', position: narrow ? 'insideEndTop' : 'end', color: T.muted, fontSize: 11 },
      data: [{ yAxis: axisMax }],
    } : undefined,
  });

  // The three gap marker kinds, one series each —— so the legend can list and toggle them separately
  for (const code of [1, 2, 3]) {
    const pts = [];
    for (let i = 0; i < labels.length; i++) {
      if (gapMap.get(i) === code) pts.push({ value: [i, axisMax] });
    }
    series.push({
      name: GAP_NAME[code],
      type: 'scatter',
      z: 5,
      symbol: SYM[code],
      symbolSize: 11,
      itemStyle: {
        color: code === 1 ? T.critical : code === 2 ? T.serious : T.muted,
        borderWidth: 1.5,
        borderColor: T.surface,
      },
      data: pts,
    });
  }

  const opt = {
    animationDuration: 260,
    // The right margin carries the "No rank" markLine label; it is trimmed on
    // narrow screens so the plot keeps a usable width.
    grid: { top: 26, right: narrow ? 30 : 62, bottom: 34, left: narrow ? 38 : 46 },
    tooltip: {
      trigger: 'axis',
      // Keeps the tooltip inside the chart box — on a phone it would otherwise
      // render past the edge of the viewport.
      confine: true,
      axisPointer: { type: 'line', snap: true, lineStyle: { color: T.axis, width: 1, type: 'solid' } },
      backgroundColor: T.surface,
      borderColor: T.grid,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: T.ink, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.13)',
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const v = vals0[i];
        const code = gapMap.get(i);
        const full = fmtFull(labels[i] || '');
        let h = '<div style="font-weight:600;margin-bottom:4px">' + full + ' UTC</div>';
        if (v > 0) {
          h += '<div style="font-size:15px;font-weight:700">#' + v + '</div>';
          const a = spans0[i * 2], b = spans0[i * 2 + 1];
          if (a > 0 && b > 0) h += '<div style="color:' + T.ink2 + ';margin-top:2px">Band #' + a + ' ~ #' + b + '</div>';
        } else if (code) {
          h += '<div style="font-size:13px;font-weight:600;color:' +
               (code === 1 ? T.critical : code === 2 ? T.serious : T.muted) + '">' + GAP_NAME[code] + '</div>';
        } else {
          h += '<div style="color:' + T.muted + '">No crawl records</div>';
        }
        return h;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: T.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        color: T.muted, fontSize: 11, hideOverlap: true,
        formatter: (val) => fmtTick(val, range.tick),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      inverse: true,              // rank 1 at the top
      min: lo,
      max: axisMax,
      // Give interval explicitly. With only min/max, if min is not on the step grid
      // (say min=1 with step=2), ECharts draws min as an extra tick,
      // producing uneven ticks like 1,2,4,6,8.
      interval: step,
      // No name —— the default end position lands in the bottom-left corner, crowding the first x-axis tick.
      // The vertical meaning is carried by the legend "Rank (each line is the median within a bucket)".
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: T.muted, fontSize: 11,
        // The bottom-most slot is the "no rank" placeholder row, so do not show it as a rank number
        formatter: (v) => (v === axisMax ? '' : v),
      },
      splitLine: { lineStyle: { color: T.grid, width: 1, type: 'solid' } },
    },
    series,
  };

  ch.setOption(opt, true);
  renderTiles(range, raw, app, cc);
  renderLegend(range, raw, spans0.length > 0);
  renderTable(range, raw, app, cc);
}

function chipFor(delta){
  if (delta === null || delta === undefined || delta === 0) {
    return '<span class="chip flat">Flat</span>';
  }
  // delta > 0: a larger rank number = rank dropped
  return delta > 0
    ? '<span class="chip dn">&#9660; Down ' + delta + '</span>'
    : '<span class="chip up">&#9650; Up ' + Math.abs(delta) + '</span>';
}

function renderTiles(range, raw, app, cc){
  const st = raw[3];
  const [onChart, observed, best, worst, median] = st;
  const cell = D.cells[appSel.value + '|' + cc];
  const cur = cell && cell[0] > 0 ? cell[0] : null;
  const rate = observed > 0 ? Math.round((onChart / observed) * 100) : 0;

  const tiles = [];
  tiles.push(
    '<div class="tile"><div class="k">Current rank</div><div class="v">'
    + (cur ? '#' + cur : '—')
    + (cell && cur ? chipFor(cell[1]) : '')
    + '</div></div>'
  );
  tiles.push('<div class="tile"><div class="k">Best in period</div><div class="v">' + (best ? '#' + best : '—') + '</div></div>');
  tiles.push('<div class="tile"><div class="k">Worst in period</div><div class="v">' + (worst ? '#' + worst : '—') + '</div></div>');
  tiles.push('<div class="tile"><div class="k">Median level</div><div class="v">' + (median ? '#' + median : '—') + '</div></div>');
  tiles.push(
    '<div class="tile"><div class="k">On-chart rate</div><div class="v">' + rate + '<small>%</small></div>'
    + '<div class="k" style="margin:3px 0 0">' + onChart + '/' + observed + ' sample points</div></div>'
  );
  $('tiles').innerHTML = tiles.join('');
}

function renderLegend(range, raw, hasSpans){
  const gapsFlat = raw[2];
  const present = new Set();
  for (let i = 1; i < gapsFlat.length; i += 2) present.add(gapsFlat[i]);
  const T = tokens();

  const items = [];
  items.push('<div class="leg-item"><span class="leg-line" style="background:' + T.series + '"></span>Rank (each line is the median within a bucket)</div>');
  if (hasSpans) {
    items.push('<div class="leg-item"><span class="leg-mark" style="background:' + T.series + ';opacity:.16;border-radius:2px"></span>Fluctuation band (best~worst)</div>');
  }
  for (const code of [1, 2, 3]) {
    if (!present.has(code)) continue;
    const col = code === 1 ? T.critical : code === 2 ? T.serious : T.muted;
    items.push('<div class="leg-item" style="color:var(--ink-2)"><span class="leg-mark" style="color:' + col + '">'
      + GAP_SVG[code] + '</span>' + GAP_NAME[code] + '</div>');
  }
  $('leg').innerHTML = items.join('');
}

function renderTable(range, raw, app, cc){
  const [vals0, spans0, gapsFlat, st] = raw;
  const labels = D.buckets[curRange];
  const gapMap = new Map();
  for (let i = 0; i < gapsFlat.length; i += 2) gapMap.set(gapsFlat[i], gapsFlat[i + 1]);

  const rows = [];
  for (let i = labels.length - 1; i >= 0; i--) {          // most recent first
    const v = vals0[i];
    const code = gapMap.get(i);
    if (!v && !code) continue;                            // buckets never observed stay out of the table
    const a = spans0[i * 2], b = spans0[i * 2 + 1];
    rows.push(
      '<tr><td>' + fmtFull(labels[i]) + '</td>'
      + '<td class="num">' + (v > 0 ? '#' + v : '—') + '</td>'
      + '<td>' + (a > 0 && b > 0 ? '#' + a + ' ~ #' + b : '—') + '</td>'
      + '<td>' + (v > 0 ? 'On chart' : (GAP_NAME[code] || '—')) + '</td></tr>'
    );
  }
  $('tblwrap').innerHTML = '<table class="mini"><thead><tr><th>Time (UTC)</th><th>Rank (median)</th><th>Fluctuation band</th><th>Status</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table>';
}

appSel.addEventListener('change', render);
ccSel.addEventListener('change', render);

// ---- Country visibility. Pure CSS toggle: the .cc-sec cells are already in
// the DOM, so this never re-renders. The button itself is hidden above 720px.
const ccBtn = $('ccbtn');
ccBtn.addEventListener('click', () => {
  const on = document.body.classList.toggle('showall');
  ccBtn.setAttribute('aria-pressed', String(on));
  ccBtn.textContent = on ? 'Show core countries only'
                         : 'Show all ' + D.countries.length + ' countries';
});

// ---- Country code reveal. The header carries only the storefront code, and a
// phone has no hover to fall back on, so tapping a header spells the name out.
// Delegated from document because render() replaces the tables wholesale.
const ccPop = $('ccpop');
let ccPopTimer = 0;
function hideCcPop() { ccPop.classList.remove('on'); }
document.addEventListener('click', (e) => {
  const th = e.target && e.target.closest ? e.target.closest('th[data-cc]') : null;
  if (!th) { hideCcPop(); return; }
  const code = th.getAttribute('data-cc').toUpperCase();
  const name = th.getAttribute('title') || code;
  // Re-tapping the open one dismisses it, so the bubble never has to be waited out.
  if (ccPop.classList.contains('on') && ccPop.dataset.cc === code) { hideCcPop(); return; }
  ccPop.dataset.cc = code;
  ccPop.textContent = code + ' — ' + name;
  ccPop.classList.add('on');
  // Measure only once it is displayed, then clamp to the viewport: the first and
  // last columns would otherwise push the bubble off an edge.
  const r = th.getBoundingClientRect();
  const w = ccPop.offsetWidth;
  const maxLeft = (window.innerWidth || document.documentElement.clientWidth) - w - 8;
  ccPop.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, maxLeft)) + 'px';
  ccPop.style.top = (r.bottom + 6) + 'px';
  clearTimeout(ccPopTimer);
  ccPopTimer = setTimeout(hideCcPop, 2400);
});
// The bubble is anchored to a rect measured at tap time, so any scroll would
// leave it pointing at the wrong cell.
window.addEventListener('scroll', hideCcPop, true);

// ---- Theme switching ----
$('theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('rm-theme', next); } catch (e) {}
  render();
});

// ---- Size changes ----
// ECharts measures its container, so it must be told when the box changes.
// Only a breakpoint crossing needs a full re-render (the chart's grid margins
// depend on it); anything else is just a resize. The debounce also covers iOS,
// which reports a stale size immediately after a rotation.
const mqNarrow = window.matchMedia('(max-width:720px)');
let lastNarrow = mqNarrow.matches, resizeTimer = 0;
function onResize(){
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    ch.resize();
    if (mqNarrow.matches !== lastNarrow) { lastNarrow = mqNarrow.matches; render(); }
  }, 120);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

render();
<\/script></body></html>`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((err) => { console.error("[dashboard]", err); process.exit(1); });
