const TELEGRAM_BOT_TOKEN_PATTERN = /(?:^|[/?#&=])bot\d{5,}:[A-Za-z0-9_-]{20,}(?=$|[/?#&=])/i;

/**
 * Return only safe public image URLs. Telegram Bot API file URLs embed the bot
 * token in the path, so never echo those URLs from customer-facing responses.
 */
export function safePublicImageUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname.toLowerCase() === "api.telegram.org" && url.pathname.startsWith("/file/bot")) {
      return null;
    }

    let decoded = url.href;
    try {
      decoded = decodeURIComponent(url.href);
    } catch {
      // The URL parser has already validated the URL; keep its canonical form.
    }
    if (TELEGRAM_BOT_TOKEN_PATTERN.test(url.href) || TELEGRAM_BOT_TOKEN_PATTERN.test(decoded)) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}
