// Offline self-check of the reseller scanner's logic (no eBay keys needed).
// Run with:  node test-resell.mjs
import { productQuery, filterComps, evaluate, dealWarnings } from "./resell.mjs";

let fail = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", name, detail);
};

// 1. Turning deal titles into eBay searches
const queries = [
  ["Sony WH-1000XM5 Noise Cancelling Wireless Headphones $198 + Free S&H", "Sony WH-1000XM5 Noise Cancelling Wireless Headphones"],
  ["45mm Garmin Instinct 3 Outdoor GPS Smartwatch (Black) $250 + Free S&H", "45mm Garmin Instinct 3 Outdoor GPS Smartwatch"],
  ["$299.99* | Garmin Forerunner 265S Running Smartwatch (42mm or 46mm, various colors) at Amazon", "Garmin Forerunner 265S Running Smartwatch"],
  ["Select BJ's Wholesale Stores: 65\" LG OLED C5 evo AI 4K Smart TV w/ 5-Yr Warranty $850 (In-Store Only)", "65 LG OLED C5 evo AI 4K Smart TV"],
  ["AstroAI Airun L6S Portable Electric Ball Pump for $20 + free shipping w/ Prime", "AstroAI Airun L6S Portable Electric Ball Pump"],
  ["LEGO Star Wars Millennium Falcon 75375 $67.99 at Walmart", "LEGO Star Wars Millennium Falcon 75375"],
  ["Prime: EcoFlow RAPID 25,000mAh 170W Laptop Power Bank w/ Dual 140W USB-C Ports $49 + Free S&H", "EcoFlow RAPID 25,000mAh 170W Laptop Power Bank"],
  ["Timberland Extra30% off: Timberland Men's Parker Street High-Top Sneaker (3 Colors) $62.99", "Timberland Men's Parker Street High-Top Sneaker"],
  ["916-Pc LEGO Creator 3-in-1 Iconic Ferris Wheel Building Set $79.95 + Free Shipping", "LEGO Creator 3-in-1 Iconic Ferris Wheel Building Set"],
  ["Star Trek: Stardate Collection (Blu-ray) $26.25 + Free S/H", "Star Trek: Stardate Collection"],
];

// 1b. Picking the real price out of a title
import { extractPrice } from "./dealwatch.mjs";
for (const [title, want] of [
  ["Target Bedding & Bath Sale: 30% off + free shipping w/ $35", null],
  ["AirPods Pro 3 $169 (Reg $249)", 169],
  ["$1,099.99 LG 65\" C5 OLED TV", 1099.99],
  ["Levi's Trucker Jacket for $54 + free shipping on orders over $50", 54],
]) {
  const got = extractPrice(title);
  check("price", got === want, `${got}  | ${title}`);
}
for (const [title, want] of queries) {
  const got = productQuery(title);
  check("query", got === want, `"${got}"${got === want ? "" : `  (wanted "${want}")`}`);
}

// 2. Filtering eBay listings down to the same product
const listings = [
  { title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones - Black NEW SEALED", total: 279 },
  { title: "Sony WH1000XM5 Noise Cancelling Headphones Silver Brand New", total: 285 },
  { title: "Hard Case for Sony WH-1000XM5 Headphones", total: 15 },
  { title: "Sony WH-1000XM4 Wireless Headphones New", total: 199 },
  { title: "Replacement Ear Pads Sony WH-1000XM5", total: 12 },
  { title: "Sony WH-1000XM5 Headphones FOR PARTS read", total: 90 },
  { title: "SONY WH-1000XM5/B Wireless Industry Leading Noise Canceling", total: 268 },
];
const q = productQuery(queries[0][0]);
const comps = filterComps(q, queries[0][0], listings);
check("comps keep real XM5s, drop case/XM4/pads/parts", comps.length === 3, comps.map((c) => c.total).join(", "));

// 3. Profit maths with default settings
const s = { min_profit: 25, min_roi_percent: 20, sales_tax_percent: 8, ebay_fee_percent: 13.6, ebay_order_fee: 0.4, shipping_cost: 12, undercut_percent: 5 };
const fake = [250, 260, 265, 270, 275, 280, 285, 290, 300, 310].map((total) => ({ total }));
const r = evaluate(150, fake, s);
// core (trim 1 each end) = 260..300, 30th pct = 270, sell = 256.5, fees = 35.28, cost = 162, profit = 47.22
check("profit maths", Math.abs(r.profit - 47.22) < 0.05, `sell ${r.sellPrice.toFixed(2)} fees ${r.fees.toFixed(2)} cost ${r.cost.toFixed(2)} profit ${r.profit.toFixed(2)} roi ${r.roi.toFixed(1)}%`);
check("thin margin is not a flip", evaluate(220, fake, s).profit < 25);

// 4. Warnings
check("warnings", dealWarnings("Select BJ's Stores: TV $850 (In-Store Only)").join() === "in-store/YMMV,membership");

console.log(fail ? `\n${fail} failed` : "\nAll passed");
process.exit(fail ? 1 : 0);
