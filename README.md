# Deal Watcher

Scans US deal sites around the clock and sends a push notification to your phone when something on your watchlist turns up under your price.

- **Where it looks:** Slickdeals (front page, popular deals, plus a search for each watchlist item), DealNews, and some Reddit deal communities (r/buildapcsales, r/GameDeals, r/frugalmalefashion, r/sneakerdeals) when Reddit allows it.
- **How often:** every 10 minutes, 24/7, on GitHub's servers for free. Your PC can be off.
- **How you're notified:** the free **ntfy** app on your phone. Tap a notification to open the deal.
- **What you get pinged about:** whatever's in [`watchlist.txt`](watchlist.txt). Edit it any time.

---

## One-time setup (about 10 minutes)

### 1. Install ntfy on your phone

1. Install **ntfy** from the [App Store](https://apps.apple.com/app/ntfy/id1625396347) or [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy).
2. Open it, tap **+** (Subscribe to topic), type your **private topic name** (the one Claude gave you, which starts with `deals-`), and tap Subscribe.
3. Allow notifications when asked.

> Treat the topic name like a password. Anyone who knows it can read your alerts. It never goes in this repository; it's stored as a GitHub *secret*.

### 2. Put the watcher on GitHub

1. Sign in to (or create) a free account at [github.com](https://github.com).
2. Click **+** (top right) → **New repository**.
   - Name: `deal-watcher`
   - Choose **Public**. Public repositories get unlimited free scanning time. Nothing private is stored in the files. *(If you choose Private, see "Private repository" below.)*
   - Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in `dealwatch.mjs`, `resell.mjs`, `watchlist.txt`, `resale-settings.txt`, `test.mjs`, `test-resell.mjs` and `README.md` from your `deal-watcher` folder, then click **Commit changes**.
4. Add the schedule file:
   - Click **Add file** → **Create new file**.
   - In the name box type exactly: `.github/workflows/deal-watch.yml` (the slashes create the folders).
   - Open `deal-watcher\.github\workflows\deal-watch.yml` on your PC in Notepad, copy everything, and paste it in.
   - Click **Commit changes**.

### 3. Give it your ntfy topic

1. In the repository, go to **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
   - Name: `NTFY_TOPIC`
   - Secret: your topic name (e.g. `deals-abc123...`)
3. Click **Add secret**.

### 4. Turn it on

1. Open the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
2. Click **Deal watch** on the left → **Run workflow** → **Run workflow**.
3. After about a minute, the run should show a green tick, and any current matching deals arrive on your phone.

From then on it runs every 10 minutes by itself.

---

## Changing what you watch

On GitHub, click `watchlist.txt` → the ✏️ pencil icon → edit → **Commit changes**. It takes effect on the next run. (This also works from your phone's browser.)

Each line is:

```
what to look for              |  max price  |  words to ignore
ps5, playstation 5            |  450        |  controller, headset, skin
airpods pro                   |  170        |  case, renewed
nike dunk                     |             |
```

- **What to look for:** one or more phrases separated by commas. A deal matches if its title has the words of any phrase, in order (other words can sit between them).
- **Max price:** in dollars. Leave it empty to accept any price. Deals with no price in the title (e.g. "Nike sale, up to 50% off") are still sent, marked *price not listed*.
- **Words to ignore:** skip deals that contain any of these. Great for cutting accessories.
- Titles like "Case **for** PS5" or "Charger **for** iPhone, Apple Watch" are skipped automatically.
- A 🔥 in the notification means the price is at least 20% under your max.

## Reseller scanner (flip finder)

Separately from your watchlist, every run also checks **each new hot deal** (Slickdeals front page and popular, DealNews), whatever it is:

1. Turns the deal title into a product search, e.g. *"Sony WH-1000XM5 Noise Cancelling Wireless Headphones"*.
2. Looks up **new, Buy-It-Now listings of the same item on eBay**, throwing out cases, parts, older models, "for parts" listings and so on.
3. Estimates a realistic sale price: the cheaper end of those listings, minus a small undercut so it sells quickly.
4. Subtracts eBay fees, shipping, and the sales tax you pay when buying.
5. Pings you only if the profit and return clear the bar in [`resale-settings.txt`](resale-settings.txt) (default: at least **$25 profit** and **20% return**).

A flip alert looks like:

> **💸 Flip: +$47.22 (29% ROI)**
> Sony WH-1000XM5 … $150
> Buy $150 (+tax $162) → resell ~$256.50 on eBay
> After eBay fees $35.28 + shipping $12. Based on 10 new listings.
> ⚠️ in-store/YMMV *(only shown when relevant)*
> [Open deal] [eBay sold prices]

**Always tap "eBay sold prices" before buying.** eBay's free API only shows items currently listed, not what actually sold. The sold-prices button opens eBay's real sold listings so you can check that it sells, and how fast, in a few seconds.

Warnings flag deals that are hard to repeat: in-store/YMMV (results vary by location), membership-only (Costco, Sam's, BJ's), coupon/rebate needed, or limited stock.

### What it can and can't check

| Marketplace | Checked? | Why |
|---|---|---|
| eBay | ✅ Yes | Official free API |
| Mercari | ❌ No | No public API, and it blocks automated access |
| Facebook Marketplace | ❌ No | Requires login, and automated access breaks Facebook's rules |

eBay prices are a reasonable guide to Mercari and Facebook too. Mercari usually sells a little lower, and Facebook local pickup has no fees or shipping.

### Turning it on: get free eBay API keys (about 10 minutes)

1. Go to [developer.ebay.com](https://developer.ebay.com) and click **Register** to create a free developer account. Approval is usually quick, but can take up to a day.
2. Once signed in, open **Application Keys** (under your name, top right). Enter an app name such as `deal-watcher` and create a **Production** keyset.
3. eBay asks how you handle *Marketplace Account Deletion* notifications before it enables production keys. Click that link, choose **exempt**, and select the reason *"I do not persist eBay data"*. That's accurate: the scanner only reads public listing prices and stores no eBay user data.
4. From the Production keyset, copy the **App ID (Client ID)** and the **Cert ID (Client Secret)**.
5. In your GitHub repository go to **Settings → Secrets and variables → Actions** and add two secrets:
   - `EBAY_CLIENT_ID`: the App ID
   - `EBAY_CLIENT_SECRET`: the Cert ID
6. Go to **Actions → Deal watch → Run workflow**. Open the run and look at the **Scan for resale flips** step to see every deal it checked and the maths behind each.

Until the eBay keys are added, the reseller step just says "skipping" and the deal watcher works as normal. The free API allows 5,000 searches a day, far more than this uses.

### Tuning it

Edit [`resale-settings.txt`](resale-settings.txt) on GitHub. The useful knobs:
- `min_profit` / `min_roi_percent`: raise them for fewer, better alerts; lower them to see more.
- `max_buy_price`: your budget per item.
- `shipping_cost`: $12 suits small items like headphones or a watch. Bigger items (TVs, vacuums) cost much more to ship, so those alerts will overstate profit. Check them carefully.
- `sales_tax_percent`: set this to your state's rate.

> This gives estimates, not guarantees. Prices move, especially on Black Friday when lots of people buy the same deal to resell. Some deals have purchase limits, and some brands restrict new-item resale. Start small: buy one, sell it, then scale up.

## Good to know

- **Each deal is sent once.** The watcher keeps a memory of what it sent in `state/seen.json` (it updates this file automatically, so don't edit it).
- **No flood.** If lots of deals match at once (e.g. the first run), you get up to 12 individual pings plus one summary.
- **Health alert.** If every deal site fails for about an hour, you get a ⚠️ notification.
- **Timing.** GitHub sometimes starts scheduled runs a few minutes late, so expect alerts within roughly 10–20 minutes of a deal being posted.
- **Reddit** often blocks automated requests from GitHub's servers. When it does, the watcher just skips it; Slickdeals and DealNews still cover nearly everything.

### Private repository

Private repositories get 2,000 free minutes a month, which isn't enough for every 10 minutes. Edit `.github/workflows/deal-watch.yml` and change `*/10 * * * *` to `*/30 * * * *` (every 30 minutes).

### Pausing it

**Actions** tab → **Deal watch** → **⋯** menu → **Disable workflow**. Use **Enable workflow** to turn it back on.

### Running it on your own PC (optional)

You need [Node.js](https://nodejs.org) 18 or newer.

```
node dealwatch.mjs --dry-run     # show what would match right now, send nothing
node test.mjs                    # check the matching rules
node test-resell.mjs             # check the reseller maths and item matching
```

To preview the reseller scanner locally, set your eBay keys first (PowerShell):
`$env:EBAY_CLIENT_ID="..."; $env:EBAY_CLIENT_SECRET="..."; node resell.mjs --dry-run`

To send real pings from your PC, set `NTFY_TOPIC` first, e.g. in PowerShell: `$env:NTFY_TOPIC="deals-..."; node dealwatch.mjs --test`
