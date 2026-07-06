---
name: Mental Gaming bot run setup
description: How to boot the Telegram bot artifact in this workspace
---

# Running the Telegram bot (`artifacts/bot`)

- Runtime: **Node.js 24** module + **pnpm**. The bot is standalone **CommonJS** (`type: commonjs`), entry `src/index.js`.
- Install deps: `pnpm --filter @workspace/bot install`. Start: `pnpm --filter @workspace/bot run start` (workflow name: **Telegram Bot**, console output, no web port — it's a Telegram long-poll service, not an HTTP server).
- **Required secrets** to boot: `BOT_TOKEN`, `MONGODB_URI`, `ADMIN_ID` (validated in `config/settings.js`). Optional: `AI_API_KEY` (Gemini AI features), `SESSION_SECRET` (AES-256 backup encryption).
- Healthy boot log: `[DB] ✅ Connected to MongoDB`, then ~40 `[Commands] ✅ …` lines, then flash-sale/feedback/sentiment watchers.

**Why:** the project arrives as a zip with no Node runtime and no secrets pre-set; these three secrets are the gate to a successful start.
