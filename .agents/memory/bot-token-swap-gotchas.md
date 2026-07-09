---
name: Bot token swap gotchas
description: What silently breaks when BOT_TOKEN is switched to a different Telegram bot (test vs prod)
---

The project runs a test bot on Replit and a real bot on a VPS, same codebase, different `BOT_TOKEN`.

Rule: after swapping `BOT_TOKEN` to a different bot, assume everything tied to the old bot's identity is broken until re-verified.

**Why:** Telegram scopes several things per-bot:
- `file_id`s (topup screenshots stored in `Transaction.screenshotUrl`, product photos) are only downloadable/sendable by the bot that received them — sending them from a new bot fails, so photo sends need text fallbacks.
- The bot must be re-added as admin in every channel (backup, announcement, game news, join-requirement channels) or getChatMember/invite-link/export calls fail silently.
- Users (incl. the admin account) must `/start` the new bot before it can DM them.

**How to apply:** when debugging "notification never arrived" or "photo won't send" after a token change, check these before suspecting code. Verify delivery with a direct `sendMessage` to `ADMIN_ID` via curl. Wrap any resend of stored file_ids in try/catch with a text fallback.
