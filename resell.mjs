#!/usr/bin/env node
/**
 * Reseller Scanner
 * ----------------
 * For every new hot deal (Slickdeals front page / popular, DealNews), looks up
 * the same item on eBay, estimates what it would resell for, subtracts eBay
 * fees, shipping and sales tax, and pings you when the profit is worth it.
 *
 * Usage:
 *   node resell.mjs             normal run
 *   node resell.mjs --dry-run   print the analysis of every deal, send nothing, save nothing
 *
 * Environment:
 *   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET   free keys from developer.ebay.com (production keyset)
 *   NTFY_TOPIC                           same ntfy topic as the deal watcher
 *
 * Resale estimate: eBay's free API shows *current* listings, not sold prices.
 * We take NEW, Buy-It-Now listings that really are the same product, use the
 * cheaper end (30th percentile) of their price incl. shipping, and assume you
 * undercut that by a few percent. Every alert has a button to open eBay's
 * SOLD listings so you can confirm real sale prices before buying.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPrice, fetchFeed, notify, tokenize, linkKey, ago, sleep, ALWAYS_FEEDS } from "./dealwatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = join(HERE, "resale-settings.txt");
const STATE_FILE = join(HERE, "state", "resell-seen.json");
const MAX_AGE_HOURS = 24;
const MAX_PINGS_PER_RUN = 8;
const FORGET_AFTER_DAYS = 14;

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  min_profit: 25, min_roi_percent: 20, min_comparable_listings: 5,
  min_buy_price: 20, max_buy_price: 600,
  sales_tax_percent: 8, ebay_fee_percent: 13.6, ebay_order_fee: 0.4, shipping_cost: 12,
  undercut_percent: 5,
};

async function loadSettings() {
  const s = { ...DEFAULTS };
  if (!existsSync(SETTINGS_FILE)) return s;
  for (const line of (await readFile(SETTINGS_FILE, "utf8")).split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").match(/^\s*([a-z_]+)\s*:\s*([\d.]+)/i);
    if (m && m[1] in s) s[m[1]] = Number(m[2]);
  }
  return s;
}

// ---------------------------------------------------------------- deal title -> product search
const STORES = "amazon|best buy|bestbuy|walmart|target|costco|sam's club|sams club|bj's|newegg|b&h|adorama|woot|ebay|macy's|kohl's|nordstrom|rei|dick's|gamestop|home depot|lowe's|staples|office depot|micro center|apple|dell|lenovo|hp|samsung|nike|adidas|zappos";

/** "45mm Garmin Instinct 3 GPS Smartwatch (Black) $250 + Free S&H" -> "45mm Garmin Instinct 3 GPS Smartwatch" */
export function productQuery(title) {
  let t = title;
  t = t.replace(/^\s*\$[\d.,]+\*?\s*\|\s*/, "");                 // "$299.99* | Garmin..."
  t = t.replace(/^[^:]{0,40}(stores?|ymmv|members?|select|prime|off|%|today|lightning|deal)[^:]*:\s*/i, ""); // "Select BJ's Stores: ...", "Prime: ..."
  t = t.replace(/\b\d[\d,]*[- ]?(pc|pcs|piece|pieces)\b\.?/gi, " "); // LEGO piece counts
  t = t.replace(/\s(for|at|only)?\s*\$[\d.,]+[\s\S]*$/i, "");    // cut at the price
  t = t.replace(new RegExp(`\\s+(at|@|from|via)\\s+(${STORES})\\b.*$`, "i"), "");
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");                    // (Black/Silver) [GPU]
  t = t.replace(/\b(w\/|with)\s.*$/i, "");                        // "w/ Prime", "with code"
  t = t.replace(/\b(new|free shipping|free s&h|deal|sale|open box|refurbished|renewed)\b/gi, " ");
  t = t.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  return t.split(" ").slice(0, 10).join(" ");
}

/** Signs a deal is hard to buy in volume or not available to everyone. */
export function dealWarnings(title) {
  const w = [];
  if (/in[- ]store|ymmv|select stores|clearance/i.test(title)) w.push("in-store/YMMV");
  if (/costco|sam'?s club|bj'?s|member/i.test(title)) w.push("membership");
  if (/targeted|w\/ code|coupon|clip|promo|after rebate|rebate/i.test(title)) w.push("needs coupon/rebate");
  if (/limit \d|limited quantity|lightning/i.test(title)) w.push("limited stock");
  return w;
}

// ---------------------------------------------------------------- eBay
const JUNK = ["case", "cover", "skin", "decal", "sticker", "protector", "replacement", "parts", "repair",
  "broken", "cracked", "empty", "box only", "manual", "charger", "cable", "strap", "band", "earpads",
  "ear pads", "tips", "mount", "stand", "dock", "remote", "lot", "bundle of", "read", "untested", "faulty",
  "compatible", "fits", "fit"];

let tokenCache = null;
async function ebayToken() {
  if (tokenCache) return tokenCache;
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`eBay login failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  tokenCache = (await res.json()).access_token;
  return tokenCache;
}

async function ebaySearch(query) {
  const filter = "conditionIds:{1000},buyingOptions:{FIXED_PRICE},itemLocationCountry:US,deliveryCountry:US";
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=50&filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await ebayToken()}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  if (!res.ok) throw new Error(`eBay search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.itemSummaries || []).map((it) => {
    const ship = (it.shippingOptions || []).map((o) => Number(o.shippingCost?.value)).filter((n) => !isNaN(n));
    return {
      title: it.title || "",
      total: Number(it.price?.value || 0) + (ship.length ? Math.min(...ship) : 0),
      url: it.itemWebUrl,
    };
  }).filter((l) => l.total > 0);
}

/** Keep only listings that are really the same product as the deal. */
export function filterComps(query, dealTitle, listings) {
  const q = tokenize(query);
  // Model numbers ("1000xm5", "c5", "3" in "Instinct 3") must all appear; sizes/units don't.
  const modelTokens = q.filter((t) => /\d/.test(t) && !/^\d+(mm|gb|tb|in|inch|oz|w|pk|pack|qt|ft)$/.test(t));
  const wordTokens = q.filter((t) => !/\d/.test(t) && t.length > 2);
  const dealTokens = new Set(tokenize(dealTitle));
  const junk = JUNK.filter((j) => !tokenize(j).every((w) => dealTokens.has(w)));
  return listings.filter((l) => {
    const lt = tokenize(l.title);
    const set = new Set(lt);
    const joined = " " + lt.join(" ") + " ";
    if (junk.some((j) => joined.includes(` ${j} `) || joined.includes(` ${j}s `))) return false;
    // "Case for Sony WH-1000XM5" -> "for" appears before the product name
    const firstHit = lt.findIndex((t) => q.includes(t));
    if (firstHit > 0 && lt.slice(0, firstHit).includes("for")) return false;
    if (!modelTokens.every((t) => set.has(t) || lt.join("").includes(t))) return false;
    const hits = wordTokens.filter((t) => set.has(t) || set.has(t + "s")).length;
    return wordTokens.length === 0 || hits / wordTokens.length >= 0.5;
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/** Resale estimate + profit maths. */
export function evaluate(buyPrice, comps, s) {
  const totals = comps.map((c) => c.total).sort((a, b) => a - b);
  // Drop the extreme 10% at each end (mispriced / scam / premium sellers).
  const trim = Math.floor(totals.length * 0.1);
  const core = totals.slice(trim, totals.length - trim || undefined);
  const low = pct(core, 0.3);
  const median = pct(core, 0.5);
  const sellPrice = low * (1 - s.undercut_percent / 100);
  const fees = sellPrice * (s.ebay_fee_percent / 100) + s.ebay_order_fee;
  const cost = buyPrice * (1 + s.sales_tax_percent / 100);
  const profit = sellPrice - fees - s.shipping_cost - cost;
  const roi = (profit / cost) * 100;
  return { sellPrice, median, fees, cost, profit, roi, count: totals.length };
}

// ---------------------------------------------------------------- state
async function loadState() {
  try { return { seen: {}, ...JSON.parse(await readFile(STATE_FILE, "utf8")) }; }
  catch { return { seen: {} }; }
}
async function saveState(state) {
  const cutoff = Date.now() - FORGET_AFTER_DAYS * 86400e3;
  for (const [k, t] of Object.entries(state.seen)) if (t < cutoff) delete state.seen[k];
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ seen: Object.fromEntries(Object.entries(state.seen).sort()) }, null, 1) + "\n");
}

const $ = (n) => "$" + (Math.round(n * 100) / 100).toFixed(n >= 100 ? 0 : 2);
const ebaySoldUrl = (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=1000`;

// ---------------------------------------------------------------- main
async function main() {
  if (!process.env.EBAY_CLIENT_ID) {
    console.log("Reseller scanner: EBAY_CLIENT_ID not set - skipping. (See README, 'Reseller scanner'.)");
    return;
  }
  const s = await loadSettings();
  const state = await loadState();

  console.log("Fetching hot deals:");
  const deals = [];
  for (const src of ALWAYS_FEEDS) {
    try { deals.push(...(await fetchFeed(src))); } catch (e) { console.log(`  FAIL ${src.name}: ${e.message}`); }
    await sleep(1000);
  }

  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  const candidates = [];
  const keys = new Set();
  for (const d of deals) {
    const key = linkKey(d.link);
    if (keys.has(key) || state.seen[key] || (d.date && d.date.getTime() < cutoff)) continue;
    keys.add(key);
    const price = extractPrice(d.title);
    if (price === null || price < s.min_buy_price || price > s.max_buy_price) {
      if (!DRY_RUN) state.seen[key] = Date.now(); // never worth re-checking
      continue;
    }
    candidates.push({ ...d, key, price, query: productQuery(d.title) });
  }
  console.log(`\nChecking ${candidates.length} new deal(s) against eBay...\n`);

  const flips = [];
  for (const d of candidates) {
    let line = `  ${$(d.price).padStart(8)}  ${d.title.slice(0, 80)}\n            eBay query: "${d.query}"`;
    try {
      const listings = await ebaySearch(d.query);
      const comps = filterComps(d.query, d.title, listings);
      if (comps.length < s.min_comparable_listings) {
        line += `\n            -> skip: only ${comps.length} matching listings (of ${listings.length})`;
      } else {
        const r = evaluate(d.price, comps, s);
        const good = r.profit >= s.min_profit && r.roi >= s.min_roi_percent;
        line += `\n            -> resell ~${$(r.sellPrice)} (median ${$(r.median)}, ${r.count} listings)  profit ${$(r.profit)}  ROI ${r.roi.toFixed(0)}%  ${good ? "✅ FLIP" : "no"}`;
        if (good) flips.push({ d, r, warnings: dealWarnings(d.title) });
      }
      if (!DRY_RUN) state.seen[d.key] = Date.now();
    } catch (e) {
      line += `\n            -> eBay error: ${e.message}`; // not marked seen: retried next run
      if (/login failed/.test(e.message)) { console.log(line); break; }
    }
    console.log(line);
    await sleep(400);
  }

  console.log(`\n${flips.length} potential flip(s).`);
  if (DRY_RUN) { console.log("(dry run - nothing sent, nothing saved)"); return; }

  flips.sort((a, b) => b.r.profit - a.r.profit);
  for (const { d, r, warnings } of flips.slice(0, MAX_PINGS_PER_RUN)) {
    try {
      await notify({
        title: `💸 Flip: +${$(r.profit)} (${r.roi.toFixed(0)}% ROI)`,
        message:
          `${d.title}\n` +
          `Buy ${$(d.price)} (+tax ${$(r.cost)}) → resell ~${$(r.sellPrice)} on eBay\n` +
          `After eBay fees ${$(r.fees)} + shipping ${$(s.shipping_cost)}. Based on ${r.count} new listings.` +
          (warnings.length ? `\n⚠️ ${warnings.join(", ")}` : "") +
          `\n${d.source}${d.date ? " · " + ago(d.date) : ""}. Check sold prices before buying!`,
        click: d.link,
        tags: ["chart_with_upwards_trend"],
        priority: r.profit >= s.min_profit * 2 ? 4 : 3,
        actions: [{ action: "view", label: "eBay sold prices", url: ebaySoldUrl(d.query) }],
      });
      await sleep(600);
    } catch (e) {
      console.log("  notify failed:", e.message);
    }
  }
  await saveState(state);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:path")).resolve(process.argv[1]);
if (isMain) main().catch((e) => { console.error("Reseller scanner crashed:", e); process.exit(1); });
