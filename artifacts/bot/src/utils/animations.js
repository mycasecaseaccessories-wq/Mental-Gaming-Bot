/**
 * Animations & Visual Feedback Utilities
 *
 * loadingMessage(ctx)         → sends "⌛ Please wait..." and returns { chatId, messageId }
 * resolveMessage(ctx, ref, text) → edits the loading message to final text
 * checklist(ctx, ref, steps)  → animates step-by-step with 600ms delay per step
 * deleteRef(ctx, ref)         → deletes a tracked message
 */

const LOADING_FRAMES = ['⌛ Please wait\\.', '⏳ Please wait\\.', '⌛ Please wait\\.\\.',  '⏳ Please wait\\.\\.',];

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Send a "loading" message and return a reference { chatId, messageId }.
 */
async function loadingMessage(ctx, text = '⌛ Please wait\\.\\.\\.') {
  const msg = await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  return { chatId: msg.chat.id, messageId: msg.message_id };
}

/**
 * Edit a tracked message ref to a final resolved text.
 */
async function resolveMessage(ctx, ref, text, opts = {}) {
  try {
    await ctx.telegram.editMessageText(ref.chatId, ref.messageId, undefined, text, {
      parse_mode: 'Markdown',
      ...opts,
    });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', ...opts });
  }
}

/**
 * Delete a tracked message ref.
 */
async function deleteRef(ctx, ref) {
  try {
    await ctx.telegram.deleteMessage(ref.chatId, ref.messageId);
  } catch {}
}

/**
 * Animate a checklist step-by-step in a single message.
 *
 * steps = [
 *   { label: 'Processing payment',  delay: 700 },
 *   { label: 'Verifying account',   delay: 800 },
 *   { label: 'Delivering product',  delay: 600 },
 * ]
 *
 * Renders as:
 *   🔄 Processing payment...
 *   ✅ Processing payment
 *   🔄 Verifying account...
 *   ✅ Processing payment
 *   ✅ Verifying account
 *   🔄 Delivering product...
 *   ✅ All done!
 */
async function checklist(ctx, ref, steps, finalText = '✅ Done!') {
  const completed = [];

  for (const step of steps) {
    const inProgress = [...completed.map((s) => `✅ ${s}`), `🔄 ${step.label}...`].join('\n');

    await resolveMessage(ctx, ref, inProgress).catch(() => {});
    await sleep(step.delay || 700);

    completed.push(step.label);
  }

  const successLines = completed.map((s) => `✅ ${s}`).join('\n');
  await resolveMessage(ctx, ref, `${successLines}\n\n${finalText}`).catch(() => {});
}

/**
 * Show a pulsing dots animation for a fixed number of ticks, then resolve.
 * Useful for long operations before you know the final result.
 */
async function pulseLoading(ctx, label = 'Loading', ticks = 3, tickMs = 500) {
  const msg = await ctx.reply(`⌛ ${label}`, { parse_mode: 'Markdown' });
  const ref = { chatId: msg.chat.id, messageId: msg.message_id };

  const dots = ['.', '..', '...'];
  for (let i = 0; i < ticks; i++) {
    await sleep(tickMs);
    await ctx.telegram
      .editMessageText(ref.chatId, ref.messageId, undefined, `⌛ *${label}*${dots[i % 3]}`, {
        parse_mode: 'Markdown',
      })
      .catch(() => {});
  }

  return ref;
}

module.exports = { loadingMessage, resolveMessage, deleteRef, checklist, pulseLoading, sleep };
