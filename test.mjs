// Quick self-check of the matching rules against the starter watchlist.
// Run with:  node test.mjs
import { matchDeal, loadWatchlist } from "./dealwatch.mjs";

const items = await loadWatchlist();
const cases = [
  ["Energizer 3-in-1 Charging Station for Phones + AirPods + Apple Watch - Black", false],
  ["Best Buy essentials 100W Charger for MacBook Pro, iPad, iPhone, Apple Watch $20.99", false],
  ["Apple Watch Series 11 GPS 42mm $279 at Amazon", true],
  ["Apple Watch Ultra 3 $699", false],
  ["The North Face Men's Nuptse Jacket $139", true],
  ["Levi's Men's 501 Original Fit Jeans $29.99", true],
  ["PS5 Slim Digital Console $399 + Free Shipping", true],
  ["DualSense Controller for PS5 $49", false],
  ["Sony PlayStation 5 Pro Console $649", false],
  ["[GPU] ASUS RTX5070 Prime $529", true],
  ["Garmin Instinct 3 AMOLED 45mm $250", true],
  ["Seiko 5 Sports SRPD Automatic Watch $189", true],
  ["Casio G-Shock GA2100 $72", true],
  ["AirPods Pro 3 Case Cover $9", false],
  ["Patagonia Jackets Black Friday Sale: Up to 40% off", true],
  ["$1,099.99 LG 65\" C5 OLED TV", true],
  ["Samsung 65\" Class - S85H OLED Series - 4K Vision AI Smart TV $899.99", true],
  ["Joyroom Apple Watch Foldable Magnetic Charging Stand $5.99", false],
  ["Apple MacBook Pro 14 with iPad Pro bundle $1999", false],
  ["iPad Pro 11\" M5 $899 at Best Buy", false],
  ["iPad Pro 11\" M4 $499 (Open box)", true],
];

let fail = 0;
for (const [title, want] of cases) {
  const m = items.map((it) => matchDeal({ title }, it)).find(Boolean);
  const ok = !!m === want;
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", want ? "match" : "skip ", m ? `[${m.phrase} ${m.price ?? "?"}]` : "", "|", title);
}
console.log(fail ? `\n${fail} failed` : "\nAll passed");
process.exit(fail ? 1 : 0);
