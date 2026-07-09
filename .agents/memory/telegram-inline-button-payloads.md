---
name: Telegram inline button payloads
description: Rules for callback_data design and shared-list mutations in the Telegraf bot
---

# Inline button payloads must use stable IDs, not array indices

**Rule:** When an inline keyboard row maps to an item in a DB-stored list, put a stable identifier (chatId, Mongo _id) in `callback_data` — never the array index.

**Why:** Buttons live in chat history indefinitely. If the list changes between render and tap (add/delete/reorder), an index resolves to the wrong item — e.g. a broadcast sent to the wrong channel or the wrong entry deleted. Caught by review on the coupon announce-channel picker.

**How to apply:**
- `callback_data` limit is 64 bytes — a 24-hex Mongo id + a Telegram chat id still fits.
- Resolve the item by the ID at tap time; if missing, reply "no longer in the list" instead of acting.
- Mutate shared lists atomically: `$pull` by ID for delete, guarded `$push` (`{'arr.key': {$ne: id}}` filter) for dedup-add — never get → splice → set.
- When starting a text-input wizard from a button, clear other wizard session flags first so another `bot.on('text')` interceptor doesn't swallow the input.

## Wizard handoff between command files
A wizard in one command file can hand off mid-flow to another file's text wizard by setting that wizard's session state at the right step (e.g. `ctx.session.cap = {step:'label', channelId}`). Works only because text handlers run in ORDER load sequence — the receiving file must be loaded before/after appropriately, and every wizard entry point must clear rival wizard session flags. Guard each text handler by its own step value so stray text in a button-only step falls through.
