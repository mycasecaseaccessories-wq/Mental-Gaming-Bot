---
name: Telegram Markdown escaping of user data
description: Any user-supplied text (esp. usernames) rendered in legacy Markdown must be escaped, or sendMessage/editMessageText throws and the whole handler "errors".
---

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
