/**
 * Financial Export — OWNER only
 *
 * Usage:
 *   /export           → prompts with options
 *   /export today     → today's report (MMT timezone)
 *   /export week      → last 7 days
 *   /export month     → last 30 days
 *   /export custom 01/05/2026 31/05/2026 → custom date range
 *
 * Output: inline summary text + CSV file attachment
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { exportReport } = require('../services/FinancialExportService');
const { auditLog } = require('../services/logger');

// ── Period selector keyboard ──────────────────────────────────────────────────
function exportMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Today',     'export_run:today'),
      Markup.button.callback('📆 Last 7 Days', 'export_run:week'),
    ],
    [
      Markup.button.callback('🗓 Last 30 Days', 'export_run:month'),
      Markup.button.callback('✏️ Custom Range', 'export_custom_prompt'),
    ],
  ]);
}

// ── CSV file sender ───────────────────────────────────────────────────────────
async function sendReport(ctx, period, customStart = null, customEnd = null) {
  const waitMsg = await ctx.reply('⏳ Generating report…');

  try {
    const { csv, summary, label } = await exportReport(period, customStart, customEnd);

    // Build filename: report_YYYYMMDD_period.csv
    const stamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const filename = `MGS_Report_${period}_${stamp}.csv`;

    // Delete the wait message
    await ctx.telegram.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});

    // Send text summary
    await ctx.reply(summary, { parse_mode: 'Markdown' });

    // Send CSV file
    await ctx.replyWithDocument(
      { source: Buffer.from('\uFEFF' + csv, 'utf-8'), filename },
      { caption: `📎 *${filename}*\n_Open in Excel or Google Sheets_`, parse_mode: 'Markdown' }
    );

    await auditLog(ctx.from.id, 'FINANCIAL_EXPORT', null, 'System', { period, label });

  } catch (err) {
    await ctx.telegram.editMessageText(
      waitMsg.chat.id, waitMsg.message_id, undefined,
      `❌ Export failed: ${err.message}`
    );
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerFinancialExport(bot) {

  // /export [period] [from] [to]
  bot.command('export', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (!args.length) {
      return ctx.reply(
        `📊 *Financial Export*\n\n` +
        `Choose a report period or use the command directly:\n\n` +
        `• \`/export today\`\n` +
        `• \`/export week\`\n` +
        `• \`/export month\`\n` +
        `• \`/export custom 01/05/2026 31/05/2026\``,
        { parse_mode: 'Markdown', ...exportMenuKeyboard() }
      );
    }

    const period = args[0].toLowerCase();

    if (period === 'custom') {
      // /export custom dd/mm/yyyy dd/mm/yyyy
      if (args.length < 3) {
        return ctx.reply(
          `✏️ *Custom Date Range*\n\n` +
          `Usage: \`/export custom DD/MM/YYYY DD/MM/YYYY\`\n\n` +
          `Example: \`/export custom 01/05/2026 31/05/2026\``,
          { parse_mode: 'Markdown' }
        );
      }

      const parseDate = (str) => {
        const [d, m, y] = str.split('/');
        if (!d || !m || !y) return null;
        const dt = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
        return isNaN(dt.getTime()) ? null : dt;
      };

      const customStart = parseDate(args[1]);
      const customEnd   = parseDate(args[2]);

      if (!customStart || !customEnd) {
        return ctx.reply('❌ Invalid date format. Use DD/MM/YYYY.', { parse_mode: 'Markdown' });
      }
      if (customStart > customEnd) {
        return ctx.reply('❌ Start date must be before end date.');
      }

      return sendReport(ctx, 'custom', customStart, customEnd);
    }

    if (!['today', 'week', 'month'].includes(period)) {
      return ctx.reply(
        '❌ Invalid period. Use: `today`, `week`, `month`, or `custom DD/MM/YYYY DD/MM/YYYY`',
        { parse_mode: 'Markdown' }
      );
    }

    return sendReport(ctx, period);
  });

  // ── Inline button handlers ────────────────────────────────────────────────

  bot.action(/^export_run:(\w+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    const period = ctx.match[1];
    return sendReport(ctx, period);
  });

  bot.action('export_custom_prompt', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});

    ctx.session.exportAwaitingCustomRange = true;
    await ctx.reply(
      `✏️ *Custom Date Range*\n\n` +
      `Send your date range in this format:\n` +
      `\`DD/MM/YYYY DD/MM/YYYY\`\n\n` +
      `Example: \`01/05/2026 31/05/2026\``,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // Text interceptor — captures custom date range input
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.exportAwaitingCustomRange) return next();
    if (Number(ctx.from?.id) !== Number(require('../../config/settings').config.bot.adminId)) return next();

    ctx.session.exportAwaitingCustomRange = false;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      return ctx.reply('❌ Please send two dates: `DD/MM/YYYY DD/MM/YYYY`', { parse_mode: 'Markdown' });
    }

    const parseDate = (str) => {
      const [d, m, y] = str.split('/');
      if (!d || !m || !y) return null;
      const dt = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
      return isNaN(dt.getTime()) ? null : dt;
    };

    const customStart = parseDate(parts[0]);
    const customEnd   = parseDate(parts[1]);

    if (!customStart || !customEnd) {
      return ctx.reply('❌ Invalid date format. Use DD/MM/YYYY DD/MM/YYYY');
    }
    if (customStart > customEnd) {
      return ctx.reply('❌ Start date must be before end date.');
    }

    return sendReport(ctx, 'custom', customStart, customEnd);
  });
};
