/**
 * errorHandler — Global error handling with crash reporting.
 *
 * Two layers:
 *   1. Telegraf middleware — catches per-update errors, replies to user, alerts admin
 *   2. setupGlobalErrorHandlers(telegram) — catches process-level uncaughtException
 *      and unhandledRejection; sends stack trace to owner; keeps bot alive
 *
 * Crash report cooldown: 5 minutes (prevents flood if crash loops)
 */

const { config } = require('../../config/settings');

const CRASH_COOLDOWN_MS  = 5 * 60_000; // 5 minutes between crash alerts
const CONTEXT_COOLDOWN_MS = 30_000;    // 30 seconds between per-user error alerts

let lastCrashAlertAt = 0;
const lastUserErrorAt = new Map(); // telegramId → timestamp

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function fmtUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Safe admin message sender ─────────────────────────────────────────────────

async function alertAdmin(telegram, text) {
  try {
    await telegram.sendMessage(config.bot.adminId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[ErrorHandler] Failed to alert admin:', e.message);
  }
}

// ── Build a crash report message ──────────────────────────────────────────────

function buildCrashReport(err, context = null) {
  const mem     = process.memoryUsage();
  const now     = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });
  const uptime  = fmtUptime(Math.floor(process.uptime()));

  // Truncate stack to avoid hitting Telegram message limit
  const stack = (err.stack || err.message || String(err))
    .split('\n')
    .slice(0, 8)
    .join('\n');

  const contextLine = context
    ? `\n📍 *Context:* ${context.trim().slice(0, 120)}\n`
    : '';

  return (
    `🚨 *Bot Crash Report*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `⏱ *Time:* ${now} MMT\n` +
    `💥 *Error:* ${String(err.message || err).slice(0, 200)}\n` +
    `🔖 *Type:* \`${err.name || 'Error'}\`` +
    `${contextLine}\n` +
    `💾 *Memory:* ${fmtMB(mem.heapUsed)} / ${fmtMB(mem.heapTotal)} heap\n` +
    `⏱ *Uptime:* ${uptime}\n\n` +
    `📋 *Stack Trace:*\n\`\`\`\n${stack}\n\`\`\``
  );
}

// ── Telegraf middleware ───────────────────────────────────────────────────────

function errorHandler() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error('[ErrorHandler] Update error:', err.message, err.stack);

      // Reply to user with generic message
      try {
        if (ctx.callbackQuery) await ctx.answerCbQuery('❌ Error. Please try again.');
        else await ctx.reply('❌ Something went wrong. Please try again or use /support.');
      } catch (_) {}

      // Rate-limit admin alerts per user
      const userId = ctx.from?.id;
      if (userId) {
        const lastAlert = lastUserErrorAt.get(userId) || 0;
        if (Date.now() - lastAlert < CONTEXT_COOLDOWN_MS) return;
        lastUserErrorAt.set(userId, Date.now());
      }

      // Build context string (command/message text + user info)
      const userStr  = ctx.from?.username ? `@${ctx.from.username}` : `ID: ${ctx.from?.id}`;
      const msgText  = ctx.message?.text || ctx.callbackQuery?.data || '[no text]';
      const context  = `"${msgText.slice(0, 80)}" from ${userStr}`;

      // Alert admin (with per-user dedup already applied above)
      try {
        await alertAdmin(ctx.telegram, buildCrashReport(err, context));
      } catch (_) {}
    }
  };
}

// ── Process-level crash handlers ──────────────────────────────────────────────

function setupGlobalErrorHandlers(telegram) {
  async function handleFatal(type, err) {
    console.error(`[ErrorHandler] 💥 ${type}:`, err);

    // Cooldown check — prevent alert storms during crash loops
    const now = Date.now();
    if (now - lastCrashAlertAt < CRASH_COOLDOWN_MS) {
      console.warn(`[ErrorHandler] Crash alert suppressed (cooldown: ${Math.round((CRASH_COOLDOWN_MS - (now - lastCrashAlertAt)) / 1000)}s remaining)`);
      return;
    }
    lastCrashAlertAt = now;

    const report = buildCrashReport(err, `Process event: ${type}`);
    await alertAdmin(telegram, report);
  }

  process.on('uncaughtException', (err) => {
    handleFatal('uncaughtException', err).catch(console.error);
    // Do NOT call process.exit() — keep bot alive
    // Note: for truly unrecoverable errors (e.g. corrupt heap), the process
    // may exit anyway. Replit's "Always On" will restart it automatically.
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    handleFatal('unhandledRejection', err).catch(console.error);
  });

  console.log('[ErrorHandler] ✅ Global crash handlers registered');
}

module.exports = { errorHandler, setupGlobalErrorHandlers };
