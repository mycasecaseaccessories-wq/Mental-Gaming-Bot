# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

- **Stack**: Node.js 24, pnpm workspaces, TypeScript 5.9, Express 5, PostgreSQL + Drizzle ORM, Zod (`zod/v4`), Orval codegen, esbuild
- **Key commands**: `pnpm run typecheck` · `pnpm run build` · `pnpm --filter @workspace/api-spec run codegen` · `pnpm --filter @workspace/db run push` (dev only) · `pnpm --filter @workspace/api-server run dev`

See the `pnpm-workspace` skill for workspace structure and package details.

---

# Mental Gaming Store — Telegram Bot (`artifacts/bot`)

Telegram bot built with **Telegraf 4.16.3** + **Mongoose 8.x** (MongoDB Atlas). CommonJS, standalone package — not part of the pnpm workspace typecheck. Run via workflow "Telegram Bot" (`pnpm --filter @workspace/bot run start`).

## Environment Variables (Replit Secrets)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `MONGODB_URI` | MongoDB connection string |
| `ADMIN_ID` | Telegram numeric user ID (owner) |
| `AI_API_KEY` | Gemini 2.0 Flash API key |
| `SESSION_SECRET` | AES-256 backup encryption key |

## ⚠️ AI Status: DISABLED (no-AI mode)

The Gemini key's free-tier quota is exhausted (429). Master switch `AI_ENABLED = false` in `services/aiService.js` — flip to `true` when a working key is configured.

While disabled:
- **Ambient chat** (`ambient.js`): no AI replies; only the direct game-news lookup answers (see Game Update Channel below)
- **Support scene**: no "AI thinking" step — tries direct game-news lookup first; no match → straight to screenshot prompt + ticket creation (sentiment = neutral)
- **Photo OCR** for game-news posts silently skips (caption-only capture works)
- AI analytics commands (`/analyticsai`, `/forecast`, `/sentimentreport`) will fail until a key with quota is set

## Architecture

### Core structure

```
artifacts/bot/
├── config/settings.js        # Env config + validation (config.bot.adminId, config.ai.apiKey)
└── src/
    ├── index.js              # Entry — boots bot, loads commands (ORDER array), starts services
    ├── database.js           # Mongoose connect
    ├── commands/             # Auto-loaded handlers; ORDER controls sequence; ambient.js MUST be last
    ├── models/               # Mongoose schemas (User, Product, Order, Promo, SystemStatus singleton, …)
    ├── middlewares/          # adminCheck (adminOnly/requireRole/isAnyAdmin), antiSpam, authUser,
    │                         # errorHandler (global crash reporter, no process.exit), maintenanceCheck, navigation
    ├── services/             # Cache, Cron, Backup, Analytics, AI, Wallet, Order, Referral, etc.
    ├── scenes/               # Telegraf Scenes: order, topup, rateManager, broadcast, spinWheel, support, onboarding
    └── utils/                # ui.js (buildMessage/stat/price), animations.js, accountAge.js
```

### Conventions

- **Roles**: Owner (`adminOnly()`), Manager (`requireRole('MANAGER')`), Staff (`requireRole('STAFF')`); `isAnyAdmin(telegramId)` for non-middleware checks
- **Command loading**: all files in `src/commands/` auto-load; ORDER array in `index.js`; text-wizard commands must come before `admin.js`/`ambient.js`
- **SystemStatus**: singleton model (`SystemStatus.get()` + `updateOne` `$set`) holds maintenance mode, gateways, channel IDs, and most feature settings
- **Escaping**: backticks inside `admin.js` GUIDE template literals must be escaped `` \` `` (unescaped ones crash command loading)
- **Global middlewares are channel_post-safe** (they skip when `ctx.from` is missing)

### SRE systems

- **CacheService** — node-cache: currency rates 15 min, products per-category 5 min; `invalidateProducts()` after admin product changes; stats in `/sysinfo`
- **CronService** (MMT = UTC+6:30) — 03:00 archive orders >6 months → `OrderArchive`; 03:05 deactivate expired promos; 03:10 stale screenshot audit; 03:20 flush cache; 06:00 encrypted backup; 09:00 account expiry reminders; 09:05 birthday gifts; 09:15 win-back; 09:30 (1st) monthly leaderboard awards; every 10 min channel auto-posts
- **BackupService** — 14 collections → JSON → gzip → AES-256-CBC (key = SHA-256 of `SESSION_SECRET`) → `SystemStatus.backupChannelId` or owner DM; `MGS_Backup_*.json.gz.enc`
- **Error handling** — per-update generic reply + rate-limited admin alert; global `uncaughtException`/`unhandledRejection` → stack trace to owner (5-min cooldown), keeps bot alive

## Features

### Orders & tracking
- **Live order tracking thread**: order placed → `OrderTrackingService.sendOrderPlaced()`; admin buttons drive Processing → Complete (delivery receipt with timeline) / Cancel & Refund; `trackingMsgId` + `statusHistory[{status, at, byAdminId, note}]` on Order; status enum includes `Processing`
- **Stale-order support prompt**: `SystemStatus.orderSupportThresholdMinutes` (default 30); age measured from last statusHistory entry; `[⚠️ Contact Support]` button auto-escalates (dedup, High-priority ticket, admin notified); `/setstalesupport <min>` (Owner)
- `/trackorder [shortId]` (all users) — live status card + refresh

### Support
- `supportScene.js`: topic → question → (AI answer if enabled | direct game-news lookup if not) → solved / escalate → optional screenshot → `SupportTicket` + admin notify with reply/template/resolve/assign/urgent buttons
- Topic picker: 2-column button layout + "📨 Admin ကို တိုက်ရိုက် စာပို့ရန်" t.me URL button — uses `SystemStatus.supportContactUsername` (set via `/setsupportcontact @username|off` OR button-driven panel: admin menu 🎫 Support Tickets → 📨 Support Contact button → `sup_contact_panel`/`sup_contact_set` (text wizard via `session.awaitingSupportContact`)/`sup_contact_off` actions in `support.js`, Owner) with fallback to owner account username auto-fetched via `getChat(adminId)` (cached 10 min); hidden if neither available
- Photo interceptor for `awaitingTicketScreenshot` lives in `support.js`

### Knowledge Channels (Game Update + FAQ) — `/gamenews` (Owner)
- Assign via `/channels` → ➕ → 🎮 Game Update (`SystemStatus.gameNewsChannelId`) or 📖 FAQ (`SystemStatus.faqChannelId`); bot must be channel admin
- `commands/gameNews.js` captures `channel_post`/`edited_channel_post` from BOTH channels into `GameNews` model (unique chatId+messageId, text index); retention: game news **90 days + newest 300 cap**; FAQ **evergreen (no age cutoff), 300 cap only**
- `findPosts()` searches both: game channel 90-day fresh, FAQ channel without age filter; `/gamenews` panel shows both channels' status
- Photo posts: largest photo → `aiService.extractImageText(base64)` (Gemini vision, extracts text + dates) appended as `[From image] …` — needs working AI key
- **No-AI direct lookup**: `services/GameNewsService.js` `findPosts(query)` ($text search → latin-keyword regex fallback; channel-scoped; game 90-day fresh, FAQ evergreen). Wired into: (1) top of `ambient.js` text handler, (2) support scene step 1 — matching posts delivered via `sendPostsAsAnswers()` (**sends stored post text directly as the answer + 🔗 "view original post" URL button**; public channels t.me/username/id, private t.me/c/… (members only); channel username/title cached 10 min via getChat)
- **AI path (when enabled)**: `aiService.loadGameNewsContext()` injects "GAME UPDATES KNOWLEDGE" block (channel-scoped, 90-day fresh, top 5 by relevance / 8 recent) into support + ambient prompts

### Channels — `/channels` (Owner)
- `services/ChannelRegistryService.js` `getKnownChannels()` merges saved list (`SystemStatus.couponAnnounceChannels`) + ChannelAutoPost + JoinReward + announcement/backup/review/game-news channel IDs with source tags; atomic guarded $push/$pull
- `commands/channelManager.js`: panel + ➕ add wizard (getChat-validated, channels only) → **purpose picker** (`chmgr_purpose:*`): 💾 saved / 📢 announce / 🔐 backup / ⭐ review (`feedbackChannelId` — FeedbackService auto-posts ⭐4–5 reviews with comments) / 🎮 game (`gameNewsChannelId`) / 📅 autopost (hands off to `ctx.session.cap` wizard) / 📣 joinbonus (hands off to `ctx.session.jbAdmin` wizard). `chmgr_add` clears rival wizard flags and vice versa
- **Channel auto-posts**: `ChannelAutoPost` model (title, body, HH:MM MMT, isActive, lastSentDate, sendCount); 10-min cron tick, dedup per MMT date; `/addchannelpost`, `/listchannelposts`, `/sendchannelpost`, `/togglechannelpost`, `/delchannelpost`

### Wallet, promos & perks
- **Coupon system** (extends Promo): `perUserLimit`, `scopeType` all/category/product, `source` admin/topup/reward; `/gencoupon` (Owner) 5-step wizard → auto code `MGS-XXXXXX` + 📢 announce-to-channel picker; **top-up coupon** granted in `WalletService.approveTopup()` (prefix `TU-`, personal, configurable via `/promoperks`); `/mycoupons` (user); orderScene shows up to 5 applicable coupons as buttons; `validatePromo` enforces scope + perUserLimit
- **Promotion perks** — `/promoperks` (Owner), engine `services/PromoPerksService.js`, settings on SystemStatus: birthday gift (`/setbirthday DD-MM`, 09:05 cron, once/year atomic), happy hour (bonus MC % in `approveTopup`, overnight ok), cashback (% MC on order complete), first-order discount (orderScene step 0, baked into unitPrice), win-back (09:15 cron, ≥N days inactive, max once/90d), monthly leaderboard (`/toplist`, 1st-of-month awards)
- **Referral tiers**: `SystemStatus.referralTiers` (Bronze 1–5→2%, Silver 6–15→3%, Gold 16+→5%); resolved in `ReferralService.processTopupCommission()`; `/setreftiers 1:2 6:3 16:5` (Owner), `/reftiers` (Manager+)
- **Referral campaigns** — `/refcamp` (Owner), `/campaign` (user): "invite N friends → reward"; one active at a time (partial unique index); `RefCampaign` + `RefCampaignEntry` models; hooked into first commission completion only; all counters conditional `findOneAndUpdate` + `$inc`; quota-full auto-end; optional `minRefereeAgeDays` (account age estimated from Telegram ID, `utils/accountAge.js`). **Reward types** (`RefCampaign.rewardType`): `mc` / `ks` (auto wallet credit), `product` (manual — owner gets "deliver it" alert), **`product_free`** (auto free-buy: on goal completion `RefCampaignService` calls `PromoService.generateCoupon` to mint a personal 100%-off coupon — `scopeType: product`, `scopeProducts: [rewardProductId]`, `restrictedToUserId`, `perUserLimit: 1`, `source: 'reward'`, prefix `REF` — user then buys the linked `rewardProductId` free in the shop; orderScene auto-lists the coupon as a button, 100% → finalAmount 0 → free order). Wizard step 4 shows an active-Product picker (`rcw_type:product_free` → `rcw_prod:<id>`).
- **Channel join bonus** (opt-in, NOT force-join) — `/joinbonus` (user, getChatMember verify, claim-record-first), `/joinbonusadmin` (Owner); `JoinReward` + `JoinRewardClaim` models; 📢 announce button posts to ALL bot users AND `announcementChannelId` (channel post: join URL + bot deep link, no callback claim button)

### Cross-bot screenshot storage
- Telegram file_ids are per-bot (dev test bot vs prod VPS bot share the same MongoDB but different tokens) — `ScreenshotStore` model stores topup screenshot **bytes** in MongoDB (60-day TTL, 5 MB cap)
- `services/ScreenshotService.js`: `saveScreenshot()` (called in topupScene right after `createPendingTopup`, best-effort) + `sendScreenshot()` (tries native file_id first, then MongoDB bytes; returns null → caller sends text fallback)
- Used in `/pendingtopups` (topup.js) and `um_ptopup` (userManagement.js); screenshots submitted BEFORE this feature only display on the bot that received them

### User management (`userManagement.js`)
- 👥 Manage Users panel → 📋 All Users / 🚫 Banned / ⚠️ Warned lists now show **per-user tappable buttons** (`um_view:<telegramId>`) opening the full user card; `/users [query]` search results also buttonized
- User card extra buttons: 📦 Orders (`um_orders` — last 10 orders w/ status icons), 💰 Topup History (`um_txs` — last 10 transactions + balances + pending count), ⏳ Pending Topup စစ်ရန် (`um_ptopup` — that user's pending topups w/ screenshot + reused `topup_approve`/`topup_reject`/`topup_askinfo` buttons); sub-views have 🔙 User Card back button
- Existing card actions: Warn/Unwarn, Ban/Unban, Restrict order/topup, Adjust Balance (`um_adjust` text wizard)

### Admin menu buttons
- `adminMenuKeyboard()` in `utils/keyboard.js`; new rows: 🎁 Promo Perks / 🎟 Coupons / 📣 Announce / 🎮 Game News / 🎁 Giveaway — `bot.hears` handlers live next to the matching `bot.command` in promoPerks.js, promo.js (gencoupon), apiManagement.js, gameNews.js, accountGiveaway.js (`/giveaway`)

### Product announcements — `/announce` or 📣 Announce button (Manager+)
- `/announce` (no arg) → picker of 15 recent active products → style choice 🆕 New Product / ⚡ Flash Sale (flash only if `flashSalePrice > 0`) → `BroadcastService.announceProductEverywhere()` sends formatted card + 🛒 deep-link buy button to BOTH announcement channel and all non-blocked bot users (`broadcastToUsers`: batch 25 / 1.1 s delay); `/announce <productId>` skips picker; result summary shows channel ok + sent/failed counts

### Premium Accounts (separate from Product system)
- Sells credentials (e.g. ExpressVPN): `AccountProduct` + `AccountCredential`; `/accounts`, `/myaccounts` (user); `/accadmin` (Owner) — add wizard (type picker first), type-aware stock paste, discount/price/toggle/delete; daily expiry reminders (cron `notifyExpiringAccounts` covers BOTH `AccountCredential` and `AccountSlot`)
- **Three account types** (`AccountProduct.accountType`): `single` (classic — one login/pw per buyer, `claimOne()`), `shared` (one login/pw shared by up to `slotsPerUnit` devices), `invite` (one URL shared by up to `slotsPerUnit` members). `slotsPerUnit`=1 for single.
- **Credential capacity** (`AccountCredential`): `credType` login/link, `link`, `capacity` (=`slotsPerUnit`), `usedSlots`; statics `claimSlots(productId,qty)` (atomic `$expr` + pipeline update: `$inc usedSlots`, flip to `sold` when full), `countAvailableSlots`, `maxFreeInOne`. Single still uses `claimOne`/`countAvailable`.
- **Pricing PER slot** for shared/invite: buyer picks qty (1..min(maxFreeInOne, 8, slotsPerUnit)) via `acc_qty`→`acc_buyq`→`acc_confirmq`; total = `finalPrice() × qty`; a buyer always draws all qty from ONE credential. Single flow (`acc_buy`/`acc_confirm`) unchanged (guarded off for multi).
- **Per-buyer sale record** `AccountSlot` (multi only) — snapshots credType/login/pw/link/note + expiry flags; single sales still recorded on `AccountCredential`. `/myaccounts` + `acc_mine` merge both via `buildMyAccounts()`. Delivery: login/pw for shared, URL for invite.
- Buy = `debitKS` total → claim (`claimOne` single | `claimSlots` multi) → deliver → refund on any failure/out-of-stock.
- **Stock-date expiry** (opt-in per product, `AccountProduct.stockDateExpiry`): a credential's fixed lifetime is counted from the **stock-add date**, not purchase. Stock-add wizard stamps `AccountCredential.stockExpiresAt = now + durationDays`. Late buyers inherit only the **remaining** days (buyer `expiresAt` set to `cred.stockExpiresAt` for single/giveaway, and `AccountSlot.expiresAt` for multi). Remaining days shown at buy picker/confirm/delivery/`My Accounts`. `freshStock()` guard (spread into all claim/count statics) hides `stockExpiresAt ≤ now` stock; `AccountCredential.retireExpiredStock()` (available→`expired`) runs at start of cron `notifyExpiringAccounts`; status enum now `available|sold|expired`; delete purges `available`+`expired`. Toggle via product card `accad_sdexp`. ⚠️ Only stock added **after** enabling gets an expiry.
- **Aging price tier** (`agingThresholdDays`, `agingDiscountPercent`, requires `stockDateExpiry`): when a credential's remaining days ≤ threshold, price drops by discount% (100% = free, skips debit/refund). `AccountProduct.priceForCredential(cred)`/`agingPrice()`/`agingEnabled()`; buyer flows use `effPrice(p)` (peeks `nextAvailable`) instead of `finalPrice()`. Config via product card `accad_aging` text wizard (`"threshold discount"` or `off`).
- **Free Giveaway** (`commands/accountGiveaway.js`): give AccountProducts away free — **multiple giveaways can run at once, one per product** (unique index on `productId`; `isActive` non-unique so several active simultaneously; `getActives()` returns all active). Restrictions all toggleable per giveaway: maxClaims 0=unlimited, endAt, minAccountAgeDays via `utils/accountAge`, requirePurchase = Order status 'Success', requireChannelId getChatMember check. `AccountGiveawayClaim` (unique giveawayId+telegramId — one claim per user **per giveaway**, claim-record-first, rollback on stock failure); claim = quota `$inc` guard → `claimOne` pricePaid 0 → deliver like purchase; auto-deactivates that giveaway on quota/stock exhaustion + owner notify. Admin: `/accadmin` → 🎁 Free Giveaway → **list of giveaways** (`accga_view:<id>`) + ➕ add (`accga_new`→`accga_pick:<productId>` creates); per-giveaway detail actions all keyed by id (`accga_toggle/max/days/age/purch/chan/chanoff/del/announce:<id>`, `accga_chansel:<gaId>:<chatId>`, `accga_repick:<id>`→`accga_setprod:<gaId>:<productId>`); reply-targeted text wizard `session.accGaWiz` stores `gaId`. Announce via `broadcastToUsers` (claim button targets `accga_free:<id>`) + announcement channel deep link `?start=freebie`. User: `/accounts` 🎁 banner/button or `/freebie` → `accga_free` entry shows single detail if 1 active, else a picker list (`accga_free:<id>`); claim `accga_claim:<id>`. 👤 Single accounts only (shared/invite auto-disabled at claim).

### Spin wheel custom rewards
- `/dashboard` → 🎰 Spin → ➕ Add Custom Reward; types coin/ks/spin/none with label/amount/weight; `GameConfig.customSpinPrizes[]` merged via `GameService.getEffectivePrizePool()`

## Admin Commands Reference

| Command | Role | Description |
|---|---|---|
| `/dashboard` | Owner | Admin dashboard (gateway panel + analytics) |
| `/sysinfo` | Manager+ | Memory, CPU, DB, cache stats, pending orders |
| `/runbackup` / `/runcron` | Owner | Manual backup / maintenance jobs |
| `/flushcache` | Manager+ | Flush in-memory cache |
| `/setbackupchan` | Owner | Set backup destination channel |
| `/analytics [period]` | Manager+ | Revenue/profit dashboard |
| `/analyticsai` `/forecast` `/sentimentreport` | Manager+ | AI reports (need working AI key) |
| `/systemhealth` | Manager+ | Gateway + system status |
| `/exportdetail` | Manager+ | CSV export (orders/transactions/users) |
| `/setgateway` `/setgatewaynote` | Owner | Payment gateway status/note |
| `/pendingtopups` | Owner | Re-list pending top-ups w/ approve/reject buttons (missed-notification recovery) |
| `/setreftiers` / `/reftiers` | Owner / Manager+ | Referral commission tiers |
| `/setstalesupport <min>` | Owner | Stale-order support threshold |
| `/setsupportcontact @username\|off` | Owner | Support direct-message contact account |
| `/announce [productId]` | Manager+ | Product announcement → all bot users + announce channel |
| `/addchannelpost` `/listchannelposts` `/sendchannelpost` `/togglechannelpost` `/delchannelpost` | Owner | Channel auto-posts |
| `/channels` | Owner | Channel registry + purpose picker |
| `/gamenews` | Owner | Game update knowledge channel status |
| `/gencoupon` | Owner | Coupon generator wizard |
| `/refcamp` | Owner | Referral campaign panel |
| `/joinbonusadmin` | Owner | Channel join bonus panel |
| `/promoperks` | Owner | Promotion perks panel (incl. top-up coupon config) |
| `/accadmin` | Owner | Premium accounts admin |
| `/checkhealth` / `/checkmodules` | Owner | Load test / module check |
| `/launchbroadcast` `/setseason` `/seasonlist` `/previewseason` | Owner | Broadcast + seasonal themes |
| `/trackorder [shortId]` | All | Live order status card |
| `/toplist` / `/setbirthday` | All | Leaderboard / birthday gift |

## Packages

`telegraf` ^4.16.3 · `mongoose` ^8.4.0 · `node-cron` ^3.0.3 · `node-cache` ^5.x · `axios` ^1.7.2 · `dotenv` ^16.4.5

---

## User Preferences

- **Always reply in Burmese** (user is non-technical).
- **Keep the in-bot Admin Guide in sync:** whenever a new admin feature is added or an existing one changes, add/update the matching section in the interactive Admin Guide (`GUIDE_SECTIONS` in `artifacts/bot/src/commands/admin.js`) in the same change — don't leave it for later.
