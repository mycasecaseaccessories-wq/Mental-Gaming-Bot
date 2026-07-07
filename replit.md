# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

---

## Mental Gaming Store — Telegram Bot (`artifacts/bot`)

A Telegram bot built with **Telegraf 4.16.3** and **Mongoose 8.x** (MongoDB Atlas). CommonJS, standalone package — not part of the pnpm workspace typecheck.

### Environment Variables (Replit Secrets)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `MONGODB_URI` | MongoDB connection string |
| `ADMIN_ID` | Telegram numeric user ID (owner) |
| `AI_API_KEY` | Gemini 2.0 Flash API key |
| `SESSION_SECRET` | AES-256 backup encryption key |

### Architecture

#### Role System
- **Owner** — full access (`adminOnly()`)
- **Manager** — analytics, broadcast, products (`requireRole('MANAGER')`)
- **Staff** — order management, support tickets (`requireRole('STAFF')`)
- `isAnyAdmin(telegramId)` — async boolean for non-middleware checks

#### Command Loading
All files in `src/commands/` are auto-loaded at startup. Order controlled by `ORDER` array in `index.js`. `ambient.js` MUST be last (catch-all AI handler).

#### Scene System
Telegraf `Scenes.Stage` — order flow, topup flow, broadcast, rate manager, spin wheel, support chat.

### Directory Structure

```
artifacts/bot/
├── config/
│   └── settings.js            # Env config + validation
├── src/
│   ├── index.js               # Entry point — boots bot, loads commands, starts services
│   ├── database.js            # Mongoose connect
│   ├── commands/              # Bot command handlers (26 files, auto-loaded)
│   │   ├── start.js           # /start, main menu
│   │   ├── shop.js            # Product browser (cached via CacheService)
│   │   ├── orders.js          # User order history
│   │   ├── wallet.js          # Wallet balance, history
│   │   ├── topup.js           # KPay/Wave/AYA/CB payment flow
│   │   ├── spin.js            # Spin wheel game
│   │   ├── checkin.js         # Daily check-in & streaks
│   │   ├── promo.js           # Promo code redemption
│   │   ├── addressBook.js     # Saved game IDs
│   │   ├── referral.js        # Referral program
│   │   ├── support.js         # AI customer support + tickets
│   │   ├── profile.js         # User profile
│   │   ├── settings.js        # Theme & display settings
│   │   ├── dashboard.js       # Admin dashboard (gateway panel + analytics buttons)
│   │   ├── adminOrders.js     # Admin order management
│   │   ├── userManagement.js  # User admin: ban/warn/adjust balance
│   │   ├── systemManagement.js# RBAC, maintenance mode, templates
│   │   ├── financialExport.js # CSV financial reports
│   │   ├── faq.js             # FAQ library + video tutorials
│   │   ├── feedback.js        # Post-order review collection
│   │   ├── apiManagement.js   # External API providers + attribution
│   │   ├── analytics.js       # Financial analytics + AI insights + sentiment
│   │   ├── sysinfo.js         # /sysinfo, /runbackup, /runcron, /flushcache
│   │   ├── health.js          # /checkhealth (50-op load test), /checkmodules
│   │   ├── launch.js          # /launchbroadcast, /setseason, /seasonlist, /previewseason
│   │   ├── channelAutoPost.js # /addchannelpost, /listchannelposts, /sendchannelpost, /togglechannelpost, /delchannelpost
│   │   ├── admin.js           # Admin panel
│   │   ├── help.js            # Help menu
│   │   └── ambient.js         # LAST: catch-all AI ambient handler
│   ├── models/                # Mongoose schemas
│   │   ├── User.js
│   │   ├── Product.js
│   │   ├── Order.js
│   │   ├── OrderArchive.js    # Archived orders > 6 months (collection: orders_archive)
│   │   ├── Transaction.js
│   │   ├── Currency.js
│   │   ├── Promo.js
│   │   ├── Review.js          # sentimentLabel + sentimentAnalyzedAt
│   │   ├── SystemStatus.js    # Singleton: maintenance, gateways, backupChannelId
│   │   ├── Admin.js
│   │   ├── AuditLog.js
│   │   ├── SupportTicket.js
│   │   ├── PaymentMethod.js
│   │   ├── FAQ.js
│   │   ├── Template.js
│   │   ├── CheckIn.js
│   │   ├── Referral.js
│   │   ├── FraudFlag.js
│   │   ├── GameCode.js
│   │   ├── AddressBook.js
│   │   ├── WebhookEvent.js
│   │   └── ProviderLog.js
│   ├── middlewares/
│   │   ├── adminCheck.js      # adminOnly(), requireRole(), isAnyAdmin()
│   │   ├── antiSpam.js        # Rate limiting
│   │   ├── authUser.js        # ctx.user attachment
│   │   ├── errorHandler.js    # Per-update handler + global crash reporter
│   │   ├── maintenanceCheck.js# Maintenance/holiday gate
│   │   └── navigationMiddleware.js
│   ├── services/
│   │   ├── CacheService.js    # node-cache: currency (15min), products (5min)
│   │   ├── CronService.js     # node-cron: archive/purge/audit/backup daily at 3AM MMT
│   │   ├── BackupService.js   # AES-256 encrypted gzip JSON backup → Telegram
│   │   ├── AnalyticsService.js# Revenue, profit, trends, category breakdown
│   │   ├── AIInsightsService.js# Gemini: monthly report, 7-day forecast, flash recs
│   │   ├── SentimentService.js# Batch AI sentiment + negative review alerts
│   │   ├── ExportService.js   # CSV export: orders/transactions/users
│   │   ├── FlashSaleService.js# Flash sale watcher
│   │   ├── FeedbackService.js # Review collection watcher
│   │   ├── currencyService.js # Rate fetch/update (cached via CacheService)
│   │   ├── NavigationService.js
│   │   ├── StyleService.js    # Seasonal theme engine (standard/thingyan/christmas/lunarnewyear/eid/custom)
│   │   ├── ThemeService.js
│   │   ├── FAQService.js
│   │   ├── PriceCalculator.js
│   │   ├── WebhookProcessor.js
│   │   ├── OrderTrackingService.js  # Live order status thread (Pending→Processing→Complete)
│   │   ├── ChannelAutoPostService.js # Scheduled channel auto-posts (10-min tick)
│   │   └── aiService.js       # callGemini() wrapper
│   ├── scenes/                # Telegraf Scenes
│   │   ├── orderScene.js      # → sends OrderTrackingService.sendOrderPlaced() after createOrder()
│   │   ├── topupScene.js
│   │   ├── rateManagerScene.js
│   │   ├── broadcastScene.js
│   │   ├── spinWheelScene.js
│   │   ├── supportScene.js
│   │   └── onboardingScene.js # 3-step tour + 100 MC welcome bonus for new users
│   └── utils/
│       ├── ui.js              # buildMessage, stat, divider, price
│       └── animations.js      # loadingMessage, pulseLoading, resolveMessage
└── package.json
```

### Referral Tier System

Configurable 3-tier commission model stored in `SystemStatus.referralTiers`.

| Tier | Min Referrals | Commission |
|---|---|---|
| 🥉 Bronze | 1–5 | 2% |
| 🥈 Silver | 6–15 | 3% |
| 🥇 Gold | 16+ | 5% |

- Rate is resolved dynamically in `ReferralService.processTopupCommission()` via `resolveTierInfo(completedCount, tiers)`
- `getStats()` returns `tier`, `nextTier`, `completedCount` — used to render progress bar in `/referral`
- Admin commands: `/setreftiers 1:2 6:3 16:5` (Owner), `/reftiers` (Manager+)

### Live Order Tracking Thread

Every order generates a status thread in the customer's Telegram chat:

1. **Order placed** (`orderScene.js`) → `sendOrderPlaced()` replies to the checklist message; `trackingMsgId` + `statusHistory[Pending]` saved to Order
2. **Admin taps 🔄 Processing** → `sendProcessing()` replies to tracking card; new `trackingMsgId` stored
3. **Admin taps ✅ Complete** → `sendDeliveredReceipt()` replies to last tracking msg; includes full timeline + delivery data
4. **Admin taps ❌ Cancel & Refund** → `sendCancelled()` replies to tracking card with refund + reason

Order model additions: `status` enum now includes `'Processing'`; new fields `trackingMsgId: Number` and `statusHistory: [{status, at, byAdminId, note}]`.

#### Stale-Order Support Prompt

Configurable via `SystemStatus.orderSupportThresholdMinutes` (default: 30).

- `ageMinutes(order)` measures time since the **last** `statusHistory` entry (or `order.timestamp` if no history), so the clock resets when admin marks Processing
- When `age >= threshold` AND order is Pending/Processing → `[⚠️ Contact Support]` button appears on the tracking card + a warning line in the card text
- Tapping it calls `autoEscalate()` which: deduplicates (no second ticket for the same order), creates a `SupportTicket` (`topic: order`, `priority: High`), notifies admin with full ticket keyboard, and confirms to the customer with the ticket ID
- `/setstalesupport <minutes>` (Owner) — update threshold; `/setstalesupport` with no args shows current value and usage

### SRE Systems (Performance, Automation, Backup)

#### CacheService (`services/CacheService.js`)
- `getCachedRates()` — currency rates, 15-min TTL
- `getCachedProducts(category)` — per-category product list, 5-min TTL
- `invalidateProducts()` — call after any admin product change
- `invalidateRates()` — called automatically after rate updates
- `getStats()` — hit rate, key count (shown in /sysinfo)

#### CronService (`services/CronService.js`)
Daily schedule (Myanmar Time = UTC+6:30):
- **03:00 MMT** — Archive `Success/Cancelled/Refunded` orders > 6 months → `OrderArchive`
- **03:05 MMT** — Deactivate expired/exhausted promo codes
- **03:10 MMT** — Log stale screenshot URLs on rejected transactions
- **03:20 MMT** — Flush in-memory cache
- **06:00 MMT** — Trigger encrypted database backup

#### BackupService (`services/BackupService.js`)
- Dumps 14 collections to compact JSON (Orders/Transactions: last 90 days)
- Compresses with `zlib.gzip`
- Encrypts with AES-256-CBC (key = SHA-256 of `SESSION_SECRET`; IV prepended)
- Sends to `SystemStatus.backupChannelId` or owner DM if not set
- Format: `MGS_Backup_YYYY-MM-DD_HHMMSS.json.gz.enc`

#### Error Handler (`middlewares/errorHandler.js`)
- Per-update: generic user reply + rate-limited admin alert
- `setupGlobalErrorHandlers(telegram)` — `uncaughtException` + `unhandledRejection`
  - Sends stack trace to owner; 5-min cooldown between alerts
  - Does NOT call `process.exit()` — keeps bot alive

### Admin Commands Reference

| Command | Role | Description |
|---|---|---|
| `/sysinfo` | Manager+ | Memory, CPU, DB, cache stats, pending orders |
| `/runbackup` | Owner | Trigger manual DB backup now |
| `/runcron` | Owner | Run all maintenance jobs manually |
| `/flushcache` | Manager+ | Flush in-memory cache |
| `/setbackupchan` | Owner | Set backup destination channel |
| `/analytics [period]` | Manager+ | Revenue/profit dashboard |
| `/analyticsai [period]` | Manager+ | Gemini AI business report |
| `/forecast` | Manager+ | 7-day sales forecast |
| `/sentimentreport` | Manager+ | Review sentiment analysis |
| `/systemhealth` | Manager+ | Gateway + system status |
| `/exportdetail` | Manager+ | CSV export (orders/transactions/users) |
| `/setgateway` | Owner | Set payment gateway online/busy/offline |
| `/setgatewaynote` | Owner | Add note to gateway status |
| `/dashboard` | Owner | Admin dashboard |
| `/setreftiers 1:2 6:3 16:5` | Owner | Set referral commission tiers (minRefs:rate pairs) |
| `/reftiers` | Manager+ | View current referral tier table |
| `/trackorder [shortId]` | All | Live order status card + 🔄 Refresh + ⚠️ Support prompt after threshold |
| `/setstalesupport <min>` | Owner | Set minutes before [Contact Support] button appears on stale orders |
| `/addchannelpost` | Owner | Wizard to schedule a daily channel auto-post (HH:MM MMT) |
| `/listchannelposts` | Owner | List all configured channel auto-posts |
| `/sendchannelpost <id>` | Owner | Send a configured post immediately (test) |
| `/togglechannelpost <id>` | Owner | Toggle auto-post active/inactive |
| `/delchannelpost <id>` | Owner | Delete a channel auto-post |

### Channel Auto-Posts

Owner-only system for scheduling daily promotional posts to Telegram channels:
- Model: `ChannelAutoPost` — `channelId`, `title`, `body` (Markdown), `scheduledHour`, `scheduledMinute`, `isActive`, `lastSentDate` (MST), `sendCount`
- Cron tick: every 10 minutes via `ChannelAutoPostService.runDuePosts()`; deduplicates per MST date
- Bot must be admin in the destination channel with post permission

### Premium Accounts System (separate from Product system)

Sells account credentials (e.g. ExpressVPN) with instant delivery, per-product duration/expiry, and discounts. Completely independent of the game top-up Product system.

- Models: `AccountProduct` (serviceName, planLabel, price KS, discountPercent 0–90, durationDays, isActive) and `AccountCredential` (loginId, password, status available/sold, buyer + soldAt/expiresAt + name snapshots; atomic `claimOne()`)
- User: `/accounts` (+ 🔐 main-menu button, i18n `menu.accounts`), buy flow = `debitKS` → `claimOne` → instant credential delivery (refund on any failure/out-of-stock); `/myaccounts` shows remaining days
- Admin (Owner): admin menu **🔐 Accounts** / `/accadmin` — add-product wizard (5 steps), bulk stock paste (`email:password` per line), discount %, price edit, toggle, delete
- Cron: daily 09:00 MMT expiry reminders (3 days before + on expiry; `notified3d`/`notifiedExpired` flags, set only after successful send or 403)
- File: `src/commands/accounts.js` in ORDER before `admin.js` (text wizard must precede ambient)

### Spin Wheel — Custom Rewards (Owner)

Admin can add unlimited custom prizes via `/dashboard → 🎰 Spin → ➕ Add Custom Reward`:
- 4 types: `coin` (Mental Coins), `ks` (cash), `spin` (free spin), `none` (thank-you)
- Each prize: label, amount, weight (probability)
- Stored in `GameConfig.customSpinPrizes[]`; merged with default pool by `GameService.getEffectivePrizePool()`
- Remove via 🗑 button in spin panel

### Packages

- `telegraf` ^4.16.3
- `mongoose` ^8.4.0
- `node-cron` ^3.0.3
- `node-cache` ^5.x
- `axios` ^1.7.2
- `dotenv` ^16.4.5

---

## User Preferences

- **Always reply in Burmese** (user is non-technical).
- **Keep the in-bot Admin Guide in sync:** whenever a new admin feature is added or an existing one changes, add/update the matching section in the interactive Admin Guide (`GUIDE_SECTIONS` in `artifacts/bot/src/commands/admin.js`) in the same change — don't leave it for later.
