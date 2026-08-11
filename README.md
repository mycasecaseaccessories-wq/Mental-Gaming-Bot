# Mental Gaming Store

Telegram store monorepo containing the main Mental Gaming Store bot, its API
server, web storefront, and Outline VPN bot.

## Main projects

- `artifacts/bot` — Telegram bot (Node.js, Telegraf, MongoDB)
- `artifacts/api-server` — backend API
- `artifacts/landing` — Vite/React storefront
- `artifacts/outline-bot` — Outline VPN bot
- `artifacts/mockup-sandbox` — isolated component preview server

## Run the Telegram bot

Install dependencies from the project root with `pnpm install`, then configure
the bot environment from `artifacts/bot/.env.example`:

```env
BOT_TOKEN=your_telegram_bot_token
MONGODB_URI=mongodb+srv://user:password@cluster/mental_gaming_store
ADMIN_ID=your_telegram_numeric_user_id
AI_API_KEY=optional_gemini_api_key
NODE_ENV=development
```

Start it with:

```bash
pnpm --filter @workspace/bot run start
```

The Replit workflow named **Telegram Bot** uses the same command.

## Announcement channel

Add the bot as a channel administrator with **Post Messages** permission.
Then use `/channels` in the bot to configure the announcement channel, or:

```text
/setannouncechannel @your_channel
/checkannounce
```

## Documentation

The bot operator guide is in `artifacts/bot/docs/ADMIN_GUIDE.md`; the source
layout is described in `artifacts/bot/docs/FILE_STRUCTURE.md`.

## Notes

- Telegram bot tests use Node's built-in test runner:
  `pnpm --filter @workspace/bot run test`
- Do not commit `.env` files or credentials.
- No database migration is needed for the giveaway UI and announcement fixes.