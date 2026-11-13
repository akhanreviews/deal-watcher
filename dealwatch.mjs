#!/usr/bin/env node
/**
 * Deal Watcher
 * ------------
 * Scans US deal feeds (Slickdeals, DealNews, a few deal subreddits) for the
 * items in watchlist.txt and sends a phone push notification through ntfy
 * when a matching deal appears.
 *
 * Usage:
 *   node dealwatch.mjs              normal run (notify + remember what was sent)
 *   node dealwatch.mjs --dry-run    show matches in the console, send nothing, save nothing
 *   node dealwatch.mjs --test       send one test notification to your phone
 *
 * Environment:
 *   NTFY_TOPIC   (required for notifications) your private ntfy topic name
 *   NTFY_SERVER  (optional) defaults to https://ntfy.sh
 *
 * No npm packages needed. Requires Node 18+.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- settings
const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE = join(HERE, "watchlist.txt");
const STATE_FILE = join(HERE, "state", "seen.json");

const MAX_AGE_HOURS = 48;          // ignore deals posted longer ago than this
const SEARCHES_PER_RUN = 8;        // Slickdeals item searches per run (rotates through the list)
const MAX_PINGS_PER_RUN = 12;      // beyond this, send one summary instead of flooding you
const FORGET_AFTER_DAYS = 21;      // how long to remember a deal we already sent
const NOTIFY_IF_NO_PRICE = true;   // send deals whose title has no $ price (e.g. "up to 50% off")
const ALERT_AFTER_FAILED_RUNS = 6; // warn you if every source fails this many runs in a row

const USER_AGENT = "Mozilla/5.0 (compatible; personal-deal-watcher/1.0)";

// Feeds checked on every run (hot / front-page deals across all categories).
const ALWAYS_FEEDS = [
  { name: "Slickdeals Frontpage", url: "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1" },
  { name: "Slickdeals Popular", url: "https://slickdeals.net/newsearch.php?mode=popdeals&searcharea=deals&searchin=first&rss=1" },
  { name: "DealNews", url: "https://www.dealnews.com/?rss=1" },
];

// Reddit is best-effort: it often rate-limits automated requests. If it
// refuses, the watcher just skips Reddit for that run.
const REDDIT_SUBS = ["buildapcsales", "GameDeals", "frugalmalefashion", "sneakerdeals"];

const slickdealsSearchUrl = (q) =>
  `https://slickdeals.net/newsearch.php?q=${encodeURIComponent(q)}&searcharea=deals&searchin=first&rss=1`;

// ---------------------------------------------------------------- helpers
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const TEST = args.has("--test");
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const clean = (s) => decodeEntities(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Turn text into a list of lowercase word tokens. "Levi's 501" -> ["levi","s","501"] */
const tokenize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** Minimal RSS + Atom parser: returns [{title, link, date}] */
function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const title = clean((block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    let link = (block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/) || [])[1];
    if (!link || !link.trim()) link = (block.match(/<link\b[^>]*href="([^"]+)"/) || [])[1];
    link = clean(link);
    const dateStr = (block.match(/<(pubDate|published|updated|dc:date)>([\s\S]*?)<\/\1>/) || [])[2];
    const date = dateStr ? new Date(clean(dateStr)) : null;
    if (title && link) out.push({ title, link, date: date && !isNaN(date) ? date : null });
  }
  return out;
}

/** First dollar amount in the title. "AirPods Pro 2 $169 (Reg $249)" -> 169 */
function extractPrice(title) {
  for (const m of title.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)) {
    // Skip amounts that aren't the item price: "free shipping w/ $35", "on orders over $50", "Reg $399"
    const before = title.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    if (/(w\/|on|over|orders?|spend|reg\.?|list|was|min\.?|of)\s*$/.test(before)) continue;
    return parseFloat(m[1].replace(/,/g, "") + (m[2] || ""));
  }
  return null;
}

/** Normalised link used to recognise the same deal across runs/feeds. */
function linkKey(link) {
  try {
    const u = new URL(link);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return link.toLowerCase();
  }
}

// ---------------------------------------------------------------- watchlist
function parsePhrases(text) {
  return text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ raw: p, words: tokenize(p) }))
    .filter((p) => p.words.length);
}

async function loadWatchlist() {
  const text = await readFile(WATCHLIST_FILE, "utf8");
  const items = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const [look = "", price = "", ignore = ""] = t.split("|").map((x) => x.trim());
    const phrases = parsePhrases(look);
    if (!phrases.length) return;
    const p = price.replace(/[$,\s]/g, "");
    const maxPrice = p === "" ? null : Number(p);
    if (maxPrice !== null && isNaN(maxPrice)) {
      log(`! watchlist.txt line ${i + 1}: "${price}" isn't a number - treating as "any price"`);
    }
    items.push({
      label: phrases[0].raw,
      phrases,
      maxPrice: maxPrice !== null && !isNaN(maxPrice) ? maxPrice : null,
      exclude: parsePhrases(ignore),
    });
  });
  return items;
}

const wordEq = (tok, w) => tok === w || tok === w + "s" || tok === w + "es"; // plurals count

/**
 * Find the phrase in the title: its words must appear in order, close together
 * (a few words may sit between them, e.g. "north face jacket" matches
 * "The North Face Men's Nuptse Jacket"). Returns the start position or -1.
 */
const MAX_GAP = 6;
function findPhrase(phrase, tokens) {
  const ws = phrase.words;
  for (let i = 0; i < tokens.length; i++) {
    if (!wordEq(tokens[i], ws[0])) continue;
    let pos = i, ok = true;
    for (let k = 1; k < ws.length && ok; k++) {
      ok = false;
      for (let j = pos + 1; j <= pos + 1 + MAX_GAP && j < tokens.length; j++) {
        if (wordEq(tokens[j], ws[k])) { pos = j; ok = true; break; }
      }
    }
    if (ok) return i;
  }
  // Multi-word phrases also match when squashed together: "rtx 5070" ~ "RTX5070"
  if (ws.length > 1) {
    const joined = ws.join("");
    const idx = tokens.findIndex((t) => t.startsWith(joined));
    if (idx >= 0) return idx;
  }
  return -1;
}

function matchDeal(deal, item) {
  const tokens = tokenize(deal.title);
  let hit = null, at = -1;
  for (const p of item.phrases) {
    at = findPhrase(p, tokens);
    if (at >= 0) { hit = p; break; }
  }
  if (!hit) return null;
  // Accessory filter: "Charger for iPhone, Apple Watch" / "Case for PS5" -> skip.
  if (tokens.slice(0, at).includes("for")) return null;
  if (item.exclude.some((p) => findPhrase(p, tokens) >= 0)) return null;
  const price = extractPrice(deal.title);
  if (item.maxPrice !== null) {
    if (price === null && !NOTIFY_IF_NO_PRICE) return null;
    if (price !== null && price > item.maxPrice) return null;
  }
  return { item, phrase: hit.raw, price };
}

// ---------------------------------------------------------------- state
async function loadState() {
  if (!existsSync(STATE_FILE)) return { seen: {}, failedRuns: 0, warned: false };
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { seen: {}, failedRuns: 0, warned: false, ...s };
  } catch {
    return { seen: {}, failedRuns: 0, warned: false };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - FORGET_AFTER_DAYS * 86400e3;
  for (const [k, t] of Object.entries(state.seen)) if (t < cutoff) delete state.seen[k];
  await mkdir(dirname(STATE_FILE), { recursive: true });
  // Sorted keys keep the file stable so git only commits real changes.
  const seen = Object.fromEntries(Object.entries(state.seen).sort());
  await writeFile(STATE_FILE, JSON.stringify({ ...state, seen }, null, 1) + "\n");
}

// ---------------------------------------------------------------- fetching
async function fetchFeed(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(source.url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const deals = parseFeed(await res.text()).map((d) => ({ ...d, source: source.name }));
    log(`  ok   ${String(deals.length).padStart(3)} deals  ${source.name}`);
    return deals;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- notify
async function notify({ title, message, click, priority = 3, tags = ["moneybag"], actions = [] }) {
  if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC is not set - can't send notifications.");
  const body = { topic: NTFY_TOPIC, title, message, priority, tags };
  if (click) {
    body.click = click;
    body.actions = [{ action: "view", label: "Open deal", url: click }, ...actions].slice(0, 3);
  }
  const res = await fetch(NTFY_SERVER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ntfy responded HTTP ${res.status}: ${await res.text()}`);
}

function ago(date) {
  if (!date) return "";
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------- main
async function main() {
  if (TEST) {
    await notify({
      title: "Deal watcher is connected ✅",
      message: "This is a test. You'll get pings like this when a deal on your watchlist shows up.",
      tags: ["white_check_mark"],
      click: "https://slickdeals.net/",
    });
    log("Test notification sent. Check your phone.");
    return;
  }

  if (!DRY_RUN && !NTFY_TOPIC) {
    log("NTFY_TOPIC is not set. Set it, or use --dry-run to just preview matches.");
    process.exit(1);
  }

  const items = await loadWatchlist();
  const state = await loadState();
  log(`Watching ${items.length} items.`);
  if (!items.length) return;

  // Which Slickdeals searches to run this time (rotates so each item is
  // searched every few runs, keeping our request count polite).
  const allSearches = items.map((it) => it.phrases[0].raw);
  const n = Math.min(SEARCHES_PER_RUN, allSearches.length);
  // Based on the clock (not saved state) so quiet runs don't change any files.
  const slot = Math.floor(Date.now() / (10 * 60e3));
  const start = (slot * n) % allSearches.length;
  const thisRun = Array.from({ length: n }, (_, i) => allSearches[(start + i) % allSearches.length]);

  const sources = [
    ...ALWAYS_FEEDS,
    ...thisRun.map((q) => ({ name: `Slickdeals search "${q}"`, url: slickdealsSearchUrl(q) })),
  ];

  log("Fetching feeds:");
  const deals = [];
  let okCount = 0;
  for (const src of sources) {
    try {
      deals.push(...(await fetchFeed(src)));
      okCount++;
    } catch (e) {
      log(`  FAIL        ${src.name}: ${e.message}`);
    }
    await sleep(1200);
  }
  for (const sub of REDDIT_SUBS) {
    try {
      deals.push(...(await fetchFeed({ name: `r/${sub}`, url: `https://www.reddit.com/r/${sub}/new/.rss` })));
      okCount++;
    } catch (e) {
      log(`  skip        r/${sub}: ${e.message}${e.status === 429 || e.status === 403 ? " (Reddit blocking - skipping Reddit this run)" : ""}`);
      if (e.status === 429 || e.status === 403) break;
    }
    await sleep(2500);
  }

  // Health check: tell the user if the watcher has gone blind.
  if (okCount === 0) {
    state.failedRuns++;
    if (state.failedRuns >= ALERT_AFTER_FAILED_RUNS && !state.warned && !DRY_RUN) {
      await notify({
        title: "Deal watcher can't reach any deal sites ⚠️",
        message: `Every source has failed for ${state.failedRuns} runs in a row. Check the Actions tab on GitHub.`,
        tags: ["warning"],
        priority: 4,
      }).catch((e) => log("  could not send warning:", e.message));
      state.warned = true;
    }
  } else {
    state.failedRuns = 0;
    state.warned = false;
  }

  // Match
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  const matches = [];
  const keysThisRun = new Set();
  for (const deal of deals) {
    if (deal.date && deal.date.getTime() < cutoff) continue;
    const key = linkKey(deal.link);
    const titleKey = "t:" + tokenize(deal.title).join(" ");
    if (state.seen[key] || state.seen[titleKey] || keysThisRun.has(key) || keysThisRun.has(titleKey)) continue;
    for (const item of items) {
      const m = matchDeal(deal, item);
      if (m) {
        matches.push({ deal, ...m, key, titleKey });
        keysThisRun.add(key);
        keysThisRun.add(titleKey);
        break;
      }
    }
  }

  log(`\n${matches.length} new matching deal(s).`);
  for (const { deal, phrase, price } of matches) {
    log(`  • [${phrase}] ${price !== null ? "$" + price : "price ?"}  ${deal.title}\n      ${deal.link}  (${deal.source}, ${ago(deal.date) || "date ?"})`);
  }

  if (DRY_RUN) {
    log("\n(dry run - nothing sent, nothing saved)");
    return;
  }

  // Notify (newest first), then summarise the rest if there are loads.
  matches.sort((a, b) => (b.deal.date?.getTime() || 0) - (a.deal.date?.getTime() || 0));
  const now = Date.now();
  let sent = 0;
  for (const m of matches.slice(0, MAX_PINGS_PER_RUN)) {
    const { deal, item, phrase, price } = m;
    const great = price !== null && item.maxPrice !== null && price <= item.maxPrice * 0.8;
    try {
      await notify({
        title: `${great ? "🔥 " : ""}${phrase}: ${price !== null ? "$" + price : "price not listed"}`,
        message: `${deal.title}\n${deal.source}${deal.date ? " · " + ago(deal.date) : ""}${item.maxPrice !== null ? ` · your max $${item.maxPrice}` : ""}`,
        click: deal.link,
        priority: great ? 4 : 3,
      });
      sent++;
      state.seen[m.key] = now;
      state.seen[m.titleKey] = now;
      await sleep(600);
    } catch (e) {
      log("  notify failed:", e.message); // not marked seen -> will retry next run
    }
  }
  const rest = matches.slice(MAX_PINGS_PER_RUN);
  if (rest.length) {
    const lines = rest.slice(0, 15).map((m) => `• ${m.price !== null ? "$" + m.price + " " : ""}${m.deal.title}`);
    try {
      await notify({
        title: `+${rest.length} more deals on your watchlist`,
        message: lines.join("\n") + (rest.length > 15 ? `\n…and ${rest.length - 15} more` : ""),
        click: "https://slickdeals.net/deals/",
      });
      for (const m of rest) {
        state.seen[m.key] = now;
        state.seen[m.titleKey] = now;
      }
    } catch (e) {
      log("  summary notify failed:", e.message);
    }
  }
  log(`Sent ${sent + (rest.length ? 1 : 0)} notification(s).`);
  await saveState(state);
}

// Run only when executed directly (lets test.mjs import the matching logic).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:path")).resolve(process.argv[1]);
if (isMain) main().catch((e) => {
  console.error("Deal watcher crashed:", e);
  process.exit(1);
});
export { matchDeal, loadWatchlist, extractPrice, fetchFeed, notify, tokenize, linkKey, ago, sleep, ALWAYS_FEEDS };
