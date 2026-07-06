/**
 * launch.js — Official launch tools and seasonal theme management.
 *
 * Launch Commands (Owner only):
 *   /launchbroadcast  — Send the official "We're LIVE!" message to all users
 *                       Creates MENTAL_LAUNCH promo code (5% off, 500 uses, 7 days)
 *
 * Seasonal Theme Commands:
 *   /setseason <id>           — Switch active seasonal theme
 *   /setseason custom <emoji> <label> <greeting>
 *   /seasonlist               — List all available themes
 *   /previewseason [id]       — Preview a theme's appearance
 */

const { Markup }   = require('telegraf');
const { adminOnly, requireRole } = require('../middlewares/adminCheck');
const StyleService = require('../services/StyleService');
const SystemStatus = require('../models/SystemStatus');
const User         = require('../models/User');
const Promo        = require('../models/Promo');

// ── Launch broadcast ──────────────────────────────────────────────────────────

const LAUNCH_PROMO_CODE  = 'MENTAL_LAUNCH';
const LAUNCH_PROMO_PCT   = 5;
const LAUNCH_PROMO_USES  = 500;
const LAUNCH_PROMO_DAYS  = 7;

const BATCH_SIZE        = 25;   // Telegram allows ~30 messages/sec
const BATCH_DELAY_MS    = 1200; // slight buffer to stay within rate limit

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLaunchPromo(adminId) {
  const expiry = new Date(Date.now() + LAUNCH_PROMO_DAYS * 86_400_000);

  const existing = await Promo.findOne({ code: LAUNCH_PROMO_CODE });
  if (existing) {
    // Re-activate if it was deactivated
    existing.isActive   = true;
    existing.expiryDate = expiry;
    await existing.save();
    return existing;
  }

  return Promo.create({
    code:          LAUNCH_PROMO_CODE,
    discountType:  'Percentage',
    value:         LAUNCH_PROMO_PCT,
    maxUses:       LAUNCH_PROMO_USES,
    expiryDate:    expiry,
    minOrderAmount: 0,
    isActive:      true,
    createdBy:     adminId,
    description:   'Official launch promo — 5% off first order',
  });
}

function buildLaunchMessage(season) {
  const decoration = season.bannerTop || '🎮 *Mental Gaming Store*';
  return (
    `${decoration}\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `🚀 *We are officially LIVE!*\n\n` +
    `🎮 *Mental Gaming Store* is now open and ready to serve you — Myanmar's most reliable gaming credit store!\n\n` +
    `What you can do right now:\n` +
    `  🛒 Buy game credits *instantly*\n` +
    `  💳 Top-up with *KBZ Pay, Wave, AYA & CB Pay*\n` +
    `  🪙 Earn *Mental Coins* on every interaction\n` +
    `  🎰 *Spin the wheel* for bonus rewards (free daily!)\n` +
    `  🤝 *Refer friends* and earn referral bonuses\n` +
    `  💎 Level up to *Gold & Platinum* for exclusive discounts\n\n` +
    `\`┌────────────────────────────┐\`\n` +
    `\`│  🎁  EXCLUSIVE LAUNCH PROMO │\`\n` +
    `\`└────────────────────────────┘\`\n` +
    `Use code: \`${LAUNCH_PROMO_CODE}\`\n` +
    `Get *${LAUNCH_PROMO_PCT}% off* your first order!\n` +
    `_Valid for ${LAUNCH_PROMO_USES} uses · Expires in ${LAUNCH_PROMO_DAYS} days_\n\n` +
    `Tap /shop to start shopping! 🎮`
  );
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerLaunch(bot) {

  // ── /launchbroadcast ────────────────────────────────────────────────────────

  bot.command('launchbroadcast', adminOnly(), async (ctx) => {
    const season = await StyleService.getActiveSeason();
    const msg    = buildLaunchMessage(season);

    // Preview first
    await ctx.reply(
      `📢 *Launch Broadcast Preview*\n\n` +
      `Here's what all users will receive:\n\n` +
      `${'─'.repeat(28)}\n${msg}\n${'─'.repeat(28)}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Send to ALL Users', 'launch_confirm')],
          [Markup.button.callback('❌ Cancel', 'launch_cancel')],
        ]),
      }
    );
  });

  bot.action('launch_confirm', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Starting broadcast…');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

    const progress = await ctx.reply('🚀 _Preparing launch broadcast…_', { parse_mode: 'Markdown' });

    try {
      // 1. Create/re-activate promo code
      const promo = await ensureLaunchPromo(ctx.from.id);
      await ctx.telegram.editMessageText(
        progress.chat.id, progress.message_id, undefined,
        `✅ Promo \`${promo.code}\` ready\n⏳ _Fetching user list…_`,
        { parse_mode: 'Markdown' }
      );

      // 2. Fetch all non-blocked users
      const users = await User.find({ isBlocked: { $ne: true } }).select('telegramId').lean();
      const season = await StyleService.getActiveSeason();
      const message = buildLaunchMessage(season);

      let sent = 0, failed = 0;
      const batches = Math.ceil(users.length / BATCH_SIZE);

      for (let b = 0; b < batches; b++) {
        const batch = users.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

        await Promise.allSettled(
          batch.map(async (u) => {
            try {
              await ctx.telegram.sendMessage(u.telegramId, message, { parse_mode: 'Markdown' });
              sent++;
            } catch (_) {
              failed++;
            }
          })
        );

        // Update progress every 3 batches
        if (b % 3 === 0 || b === batches - 1) {
          await ctx.telegram.editMessageText(
            progress.chat.id, progress.message_id, undefined,
            `🚀 *Broadcasting…*\n\n` +
            `📤 Sent: *${sent}* | ❌ Failed: *${failed}*\n` +
            `📊 Progress: ${b + 1}/${batches} batches (${Math.round(((b + 1) / batches) * 100)}%)\n\n` +
            `_Please wait…_`,
            { parse_mode: 'Markdown' }
          );
        }

        if (b < batches - 1) await sleep(BATCH_DELAY_MS);
      }

      await ctx.telegram.editMessageText(
        progress.chat.id, progress.message_id, undefined,
        `✅ *Launch Broadcast Complete!*\n\n` +
        `📤 Sent: *${sent}*\n` +
        `❌ Failed (blocked/deleted): *${failed}*\n` +
        `🎟 Promo: \`${LAUNCH_PROMO_CODE}\` — ${LAUNCH_PROMO_PCT}% off, ${LAUNCH_PROMO_USES} uses, ${LAUNCH_PROMO_DAYS} days\n\n` +
        `_Mental Gaming Store is officially live!_ 🚀`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(
        progress.chat.id, progress.message_id, undefined,
        `❌ Broadcast error: ${err.message}`
      );
    }
  });

  bot.action('launch_cancel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply('❌ Launch broadcast cancelled.');
  });

  // ── /setseason ──────────────────────────────────────────────────────────────

  bot.command('setseason', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const id   = args[0]?.toLowerCase();

    if (!id) {
      const current = await StyleService.getActiveSeason();
      return ctx.reply(
        `🎨 *Seasonal Theme Engine*\n\n` +
        `Active theme: *${current.label}*\n\n` +
        `Usage:\n` +
        `  \`/setseason standard\`\n` +
        `  \`/setseason thingyan\`\n` +
        `  \`/setseason christmas\`\n` +
        `  \`/setseason lunarnewyear\`\n` +
        `  \`/setseason eid\`\n` +
        `  \`/setseason custom 🌸 "Blossom Season" "Happy Blossom!"\`\n\n` +
        `Use /seasonlist to see all themes.`,
        { parse_mode: 'Markdown' }
      );
    }

    const validIds = Object.keys(StyleService.SEASONS);
    if (!validIds.includes(id)) {
      return ctx.reply(`❌ Unknown theme: \`${id}\`\n\nValid: ${validIds.join(', ')}`, { parse_mode: 'Markdown' });
    }

    const fields = { seasonalTheme: id };

    if (id === 'custom') {
      // /setseason custom 🎊 "Label" "Greeting message"
      const emoji    = args[1] || '🎉';
      // Parse quoted label and greeting
      const rest = args.slice(2).join(' ');
      const matches  = rest.match(/"([^"]+)"/g) || [];
      const label    = matches[0]?.replace(/"/g, '') || 'Custom Event';
      const greeting = matches[1]?.replace(/"/g, '') || 'Something special is happening!';
      fields.customSeasonEmoji    = emoji;
      fields.customSeasonLabel    = label;
      fields.customSeasonGreeting = greeting;
    }

    await SystemStatus.set(fields, ctx.from.id);
    StyleService.invalidateSeason();

    const season = await StyleService.getActiveSeason();
    await ctx.reply(
      `✅ *Season set to: ${season.label}*\n\n${StyleService.buildPreview(season)}\n\n_All welcome messages now reflect the new theme._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /seasonlist ─────────────────────────────────────────────────────────────

  bot.command('seasonlist', requireRole('MANAGER'), async (ctx) => {
    const current = await StyleService.getActiveSeason();
    const list    = StyleService.getSeasonList();

    const lines = list.map((s) =>
      `${s.id === current.id ? '▶️' : '  '} \`${s.id}\` — ${s.label}`
    ).join('\n');

    await ctx.reply(
      `🎨 *Available Seasonal Themes*\n\n${lines}\n\n_▶️ = currently active_\n\nUse \`/setseason <id>\` to switch.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /previewseason ──────────────────────────────────────────────────────────

  bot.command('previewseason', requireRole('MANAGER'), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const id   = args[0]?.toLowerCase();

    const season = id && StyleService.SEASONS[id]
      ? StyleService.SEASONS[id]
      : await StyleService.getActiveSeason();

    await ctx.reply(
      `🎨 *Preview: ${season.label}*\n\n${StyleService.buildPreview(season)}`,
      { parse_mode: 'Markdown' }
    );
  });
};
