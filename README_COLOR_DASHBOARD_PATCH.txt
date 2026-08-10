Mental Gaming Bot — Colored Product Buttons + Dashboard Markdown Fix

Changed files:
- artifacts/bot/src/commands/shop.js
- artifacts/bot/src/commands/dashboard.js

Changes:
1) Product/package inline buttons use native Telegram styles:
   - in stock / unlimited: success (green)
   - out of stock: danger (red)
   - product detail Order Now: success (green)
   - Share: primary (blue)
   - Back: danger (red)
2) Removed green/red status-dot emoji from product button labels; the whole button carries the status color.
3) Out-of-stock detail uses a red Out of Stock button and blocks order start.
4) Admin Dashboard escapes dynamic Markdown values (usernames, product names, payment methods, gateway names/notes, currency codes) to prevent Telegram 400 "can't parse entities" failures.
5) System Health gateway names/notes get the same Markdown escaping.

No database migration required.
