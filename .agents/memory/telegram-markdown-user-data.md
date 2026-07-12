---
name: Telegram Markdown escaping of user data
description: Any user-supplied text (esp. usernames) rendered in legacy Markdown must be escaped, or sendMessage/editMessageText throws and the whole handler "errors". Also covers the 4096-char message cap.
---

# Telegram message length cap (4096 chars)

A single Telegram message is capped at 4096 chars — over that, send/edit throws
and the handler surfaces a "crash" error. The in-bot Admin Guide sections
(`GUIDE_SECTIONS` in `admin.js`) grow every time an admin feature is added, and
one section silently crossed 4096 after an edit → clicking that guide button
errored (the try/reply fallback also failed because the body was still too long).

**How to apply:** render long bodies through a splitter that breaks on `\n`
boundaries (each guide line keeps its Markdown entities balanced, so splitting
between lines never corrupts the parse) into <=~3900-char chunks; only the last
chunk carries the inline keyboard. When editing the guide, don't assume a single
message will fit.


# Escape user-controlled text before rendering in Telegram Markdown

Telegraf's legacy `parse_mode:'Markdown'` fails the entire message send when the
text contains an unbalanced reserved char (`_ * ` [`). Telegram usernames,
first names, product notes, etc. are user-controlled and frequently contain `_`.
An unescaped `@${user.username}` with an underscore username makes
`ctx.reply`/`editMessageText` reject → the handler surfaces a generic error.

**Why:** a real "My Profile" crash was traced to one customer whose username
contained `_`. The admin (English, clean username) never hit it, so it looked
intermittent. The bug is in the *data*, not the code path.

**How to apply:**
- Wrap every dynamic string interpolated into a Markdown template with an
  `esc()` helper: `String(s).replace(/([_*`\[])/g, '\\$1')`.
- Keep a defensive fallback in the shared navigation/reply layer: on a Markdown
  send failure, retry the reply without `parse_mode` so users see plain text
  instead of an error.
- Consider `MarkdownV2` + full escaping for new code, but the cheap fix is
  escaping user data in the existing legacy-Markdown templates.
