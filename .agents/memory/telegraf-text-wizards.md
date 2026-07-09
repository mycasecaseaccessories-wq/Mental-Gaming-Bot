---
name: Telegraf text-wizard interception
description: How to write bot.on('text') wizard steps so they don't swallow admin menu button text or other flows
---

# Reply-targeted text wizards

Rule: any `bot.on('text')` wizard step must NOT consume arbitrary text based only on a boolean session flag. Store the forceReply prompt's `message_id` in the session flag and only consume messages where `ctx.message.reply_to_message?.message_id` matches; for any other text, clear the flag and call `next()`.

**Why:** command files register in a fixed ORDER; an early broad text handler (e.g. in support.js) swallowed admin reply-keyboard button labels (📣 Announce, 🎟 Coupons, …) registered in later files, silently breaking those buttons whenever the wizard flag was stale.

**How to apply:** whenever adding a new text-input wizard triggered by an inline button, follow the reply-targeted pattern (prompt with `Markup.forceReply()`, save `prompt.message_id`, match on reply, re-prompt updates the stored id). Also remember: admin menu button labels are exact-match `bot.hears` strings — keep them unique across the keyboard.

**Wizard isolation across files:** when two command files each keep their own wizard session flag, a stale flag from one file can hijack text meant for the other (older broad wizards consume ANY owner text). On every wizard entry point, clear the rival file's session flag before setting your own (mutual clearing) — architect flagged this as a blocking bug in the account-giveaway feature.
