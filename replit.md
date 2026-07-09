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
- Topic picker: 2-column button layout + "📨 Admin ကို တိုက်ရိုက် စာပို့ရန်" t.me URL button (admin username auto-fetched via `getChat(adminId)`, cached 10 min; hidden if admin has no username)
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
- **Referral campaigns** — `/refcamp` (Owner), `/campaign` (user): "invite N friends → reward"; one active at a time (partial unique index); `RefCampaign` + `RefCampaignEntry` models; hooked into first commission completion only; all counters conditional `findOneAndUpdate` + `$inc`; quota-full auto-end; optional `minRefereeAgeDays` (account age estimated from Telegram ID, `utils/accountAge.js`)
- **Channel join bonus** (opt-in, NOT force-join) — `/joinbonus` (user, getChatMember verify, claim-record-first), `/joinbonusadmin` (Owner); `JoinReward` + `JoinRewardClaim` models

### Premium Accounts (separate from Product system)
- Sells credentials (e.g. ExpressVPN): `AccountProduct` + `AccountCredential` (atomic `claimOne()`); buy = `debitKS` → claim → instant delivery (refund on failure); `/accounts`, `/myaccounts` (user); `/accadmin` (Owner) — add wizard, bulk `email:password` paste, discount/price/toggle/delete; daily 09:00 expiry reminders

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
| `/setreftiers` / `/reftiers` | Owner / Manager+ | Referral commission tiers |
| `/setstalesupport <min>` | Owner | Stale-order support threshold |
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
