---
name: Outline VPN feature
description: How the Outline VPN auto-key system is structured in the bot codebase
---

# Outline VPN feature

## Architecture
- Models: `OutlineServer`, `OutlineKey`, `OutlinePlan`, `OutlineFreeConfig` in `artifacts/bot/src/models/`
- Service: `OutlineService.js` in `artifacts/bot/src/services/` — axios-based wrapper for Outline Management API, uses `rejectUnauthorized: false` for self-signed certs
- Commands: `outlineAdmin.js` (admin panel) and `outlineUser.js` (user menu) in `artifacts/bot/src/commands/`

## Key design decisions
- `outlineAdmin.js` registered BEFORE `ambient.js` in index.js ORDER list; uses `ctx.session.outlineAdminWizard = { step, data }` for multi-step wizard state
- `outlineUser.js` handles user menu via `bot.hears('🌐 Outline VPN', ...)` — i18n key `menu.outline_vpn` added to i18n.js
- Admin keyboard updated in `keyboard.js` adminMenuKeyboard() — added `'🔑 Outline VPN'` row
- Main menu keyboard updated — added `[L('menu.outline_vpn')]` row

**Why:** Follows existing pattern of session-based wizard state (same as accounts.js, promoPerks.js). Admin-only middleware `adminOnly()` wraps all admin actions.

## Missing piece
- No expiry cron job yet — `OutlineKey.findExpiredActive()` static exists but nothing calls it. Task #6 tracks this.
- Free key cooldown field stored in config but not enforced at claim time (simple to add: check last key's createdAt).
