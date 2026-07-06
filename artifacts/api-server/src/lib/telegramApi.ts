/**
 * Minimal Telegram Bot API client used by the Mini App backend to forward
 * payment-proof photos to the bot's admin DM with the same inline keyboard
 * the bot itself uses, so admin approval flows continue to work unchanged.
 */

import { logger } from "./logger";

const BOT_API = "https://api.telegram.org";

function botToken(): string {
  const t = process.env["BOT_TOKEN"];
  if (!t) throw new Error("BOT_TOKEN is not configured");
  return t;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendPhotoOptions {
  chatId: number | string;
  photo: Buffer;
  filename: string;
  contentType: string;
  caption?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  inlineKeyboard?: InlineButton[][];
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramSendPhotoResult {
  message_id: number;
  photo: TelegramPhotoSize[];
}

/**
 * Send a photo as multipart/form-data to a chat. Returns the largest
 * `file_id` (Telegram-assigned, content-addressable, reusable).
 */
export async function sendPhoto(
  opts: SendPhotoOptions
): Promise<{ fileId: string; messageId: number }> {
  const url = `${BOT_API}/bot${botToken()}/sendPhoto`;
  const form = new FormData();
  form.append("chat_id", String(opts.chatId));
  if (opts.caption) form.append("caption", opts.caption);
  if (opts.parseMode) form.append("parse_mode", opts.parseMode);
  if (opts.inlineKeyboard) {
    form.append(
      "reply_markup",
      JSON.stringify({ inline_keyboard: opts.inlineKeyboard })
    );
  }
  // Convert Buffer → Blob for FormData (Node 20+ has global File/Blob).
  const blob = new Blob([new Uint8Array(opts.photo)], { type: opts.contentType });
  form.append("photo", blob, opts.filename);

  const res = await fetch(url, { method: "POST", body: form });
  const json = (await res.json()) as {
    ok: boolean;
    result?: TelegramSendPhotoResult;
    description?: string;
  };
  if (!json.ok || !json.result) {
    logger.error({ desc: json.description }, "Telegram sendPhoto failed");
    throw new Error(json.description || "Telegram sendPhoto failed");
  }
  const photos = json.result.photo;
  const largest = photos[photos.length - 1];
  if (!largest) throw new Error("Telegram returned no photo sizes");
  return { fileId: largest.file_id, messageId: json.result.message_id };
}

/**
 * Send a plain text message — used for notifying the user after admin
 * actions, or for sending complementary admin context messages.
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  parseMode: "Markdown" | "HTML" = "Markdown"
): Promise<void> {
  const url = `${BOT_API}/bot${botToken()}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) {
    logger.warn({ desc: json.description, chatId }, "Telegram sendMessage failed");
  }
}
