# Project File Structure

## Telegram bot

- `config/` — environment validation and settings
- `src/index.js` — bot startup, middleware, command loading, Telegram command registration
- `src/commands/` — user, admin, channel, product, order, support, and system handlers
- `src/scenes/` — multi-step conversations
- `src/services/` — reusable business logic and scheduled jobs
- `src/models/` — MongoDB/Mongoose schemas
- `src/middlewares/` — auth, roles, anti-spam, maintenance, and error handling
- `src/utils/` — keyboards, i18n, formatting, and shared helpers
- `test/` — Node.js built-in test runner tests
- `docs/` — durable operator documentation

## Other artifacts

- `artifacts/api-server/` — API server
- `artifacts/landing/` — storefront web app
- `artifacts/outline-bot/` — Outline VPN bot
- `artifacts/mockup-sandbox/` — isolated UI preview server

Keep service-specific code inside its artifact. Do not mix API, storefront,
Outline bot, and Telegram store code into one `src/` directory.