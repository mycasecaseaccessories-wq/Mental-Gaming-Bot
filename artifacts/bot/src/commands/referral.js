/**
 * Referral Command Suite
 *
 * User commands:
 *   /referral    — full dashboard with stats, link, and recent referrals
 *   /reflink     — quick shareable invite message
 *   /reflead     — public leaderboard (top 10 referrers)
 *
 * Admin commands (MANAGER+):
 *   /refstats    — global referral system stats
 *   /setcommission <rate> [first|every] [KS|Coin|Both]
 *                — e.g. /setcommission 3 every KS
 *   /refadjust <userId> <+/-amount> [note]
 *                — e.g. /refadjust 123456789 +500 manual compensation
 *   /reffraud    — list unresolved fraud flags
 */

const { Markup }  = require('telegraf');
const { requireRole, adminOnly } = require('../middlewares/adminCheck');
const {
  getOrCreateCode,
  getReferralLink,
  getStats,
  getLeaderboard,
  adminAdjustCommission,
  resolveTierInfo,
  DEFAULT_TIERS,
} = require('../services/ReferralService');
const { registerFraudActions } = require('../services/FraudDetector');
const { auditLog }    = require('../services/logger');
const { price }       = require('../utils/ui');
const Referral        = require('../models/Referral');
const FraudFlag       = require('../models/FraudFlag');
const SystemStatus    = require('../models/SystemStatus');
const User            = require('../models/User');

// ── Tier progress section builder ─────────────────────────────────────────────

function buildTierProgress(stats) {
  const { tier, nextTier, completedCount, commissionRate } = stats;

  if (!tier) {
    const first = nextTier || DEFAULT_TIERS[0];
    if (!first) return '';
    return (
      `\`──────────────────────\`\n` +
      `🏅 *Tier:* No tier yet — refer *${first.minRefs}* friend${first.minRefs > 1 ? 's' : ''} to unlock *${first.emoji} ${first.label}* (${first.rate}%)\n`
    );
  }

  let line = `\`──────────────────────\`\n${tier.emoji} *${tier.label} Tier* — Commission: *${commissionRate}%*\n`;

  if (nextTier) {
    const start    = tier.minRefs - 1;
    const end      = nextTier.minRefs - 1;
    const position = Math.min(completedCount - start, end - start);
    const filled   = Math.max(0, Math.round((position / (end - start)) * 12));
    const empty    = 12 - filled;
    const bar      = '█'.repeat(filled) + '░'.repeat(empty);
    line +=
      `📊 \`${bar}\` ${completedCount}/${nextTier.minRefs}\n` +
      `_${nextTier.minRefs - completedCount} more to ${nextTier.emoji} ${nextTier.label} (${nextTier.rate}%)_\n`;
  } else {
    line += `🏆 *Max Tier Reached!* You're at the highest commission rate.\n`;
  }

  return line;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_ICON = {
  Pending:   '⏳',
  Active:    '🔄',
  Completed: '✅',
  Frozen:    '🔒',
};

function modeLabel(mode, type) {
  const m = mode === 'every' ? 'Every Top-up' : 'First Top-up Only';
  return `${m} • ${type}`;
}

// ── Share invite text (rich visual message) ────────────────────────────────────

function buildShareText(stats) {
  return (
    `🎮 *Join Mental Gaming Store!*\n\n` +
    `Myanmar's best game top-up store:\n` +
    `  ✅ MLBB, Free Fire, PUBG & more\n` +
    `  ✅ Instant delivery\n` +
    `  ✅ Trusted by thousands\n\n` +
    `🎁 *Join with my link and get:*\n` +
    `  🪙 *+${(stats.welcomeBonus.coins).toLocaleString()} Mental Coins* welcome bonus\n\n` +
    `👇 Tap to join:\n${stats.link}`
  );
}

// ── /referral — full dashboard ────────────────────────────────────────────────

module.exports = function registerReferral(bot) {

  async function sendReferralAdminPanel(ctx, edit = false) {
    const status = await SystemStatus.get();
    const [total, completed, active, pending, frozen, flagged] = await Promise.all([
      Referral.countDocuments({}),
      Referral.countDocuments({ status: 'Completed' }),
      Referral.countDocuments({ status: 'Active' }),
      Referral.countDocuments({ status: 'Pending' }),
      Referral.countDocuments({ status: 'Frozen' }),
      FraudFlag.countDocuments({ resolved: false }),
    ]);
    const text =
      `🔗 *Referral Manager*\n` +
      `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `Program: *${status.referralEnabled ? '🟢 Active' : '🔴 Paused'}*\n` +
      `Commission: *${status.referralCommissionRate}%* · *${status.referralCommissionMode === 'every' ? 'Every top-up' : 'First top-up'}*\n` +
      `Minimum top-up: *${(status.referralMinTopup || 1000).toLocaleString()} KS*\n\n` +
      `👥 Total: *${total}*  ✅ Completed: *${completed}*\n` +
      `🔄 Active: *${active}*  ⏳ Pending: *${pending}*\n` +
      `🔒 Frozen: *${frozen}*  ⚠️ Fraud review: *${flagged}*`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📊 Refresh Stats', 'ref_admin_panel'), Markup.button.callback(status.referralEnabled ? '🔴 Pause Referral' : '🟢 Enable Referral', 'ref_admin_toggle')],
      [Markup.button.callback('⚙️ Commission Settings', 'ref_admin_settings')],
      [Markup.button.callback('🏆 Tier Settings', 'ref_admin_tiers')],
      [Markup.button.callback(`🛡 Fraud Review (${flagged})`, 'ref_admin_fraud')],
      [Markup.button.callback('🛠 Fraud Rules', 'ref_admin_fraud_rules')],
      [Markup.button.callback('🎯 Referral Campaign', 'rc_panel')],
      [Markup.button.callback('↩️ Admin Marketing', 'nav:go:admin_main')],
    ]);
    if (edit && ctx.callbackQuery?.message) return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }

  bot.hears('🔗 Referral Manager', adminOnly(), (ctx) => sendReferralAdminPanel(ctx));
  bot.action('ref_admin_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    return sendReferralAdminPanel(ctx, true);
  });

  bot.action('ref_admin_toggle', adminOnly(), async (ctx) => {
    const status = await SystemStatus.get();
    const enabled = !status.referralEnabled;
    await SystemStatus.set({ referralEnabled: enabled }, ctx.from.id);
    await auditLog(ctx.from.id, enabled ? 'REFERRAL_ENABLED' : 'REFERRAL_DISABLED', null, 'System', {});
    await ctx.answerCbQuery(enabled ? 'Referral enabled' : 'Referral paused');
    return sendReferralAdminPanel(ctx, true);
  });

  bot.action('ref_admin_settings', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.get();
    return ctx.editMessageText(
      `⚙️ *Referral Commission Settings*\n\nRate: *${status.referralCommissionRate}%*\nMode: *${status.referralCommissionMode === 'every' ? 'Every top-up' : 'First top-up'}*\nMinimum top-up: *${(status.referralMinTopup || 1000).toLocaleString()} KS*\n\nRate နဲ့ mode ကို button နဲ့ပြောင်းပါ။`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [1, 2, 3, 5].map((rate) => Markup.button.callback(`${rate}%`, `ref_admin_rate:${rate}`)),
        [Markup.button.callback('🟢 First top-up', 'ref_admin_mode:first'), Markup.button.callback('🔁 Every top-up', 'ref_admin_mode:every')],
        [Markup.button.callback('↩️ Referral Manager', 'ref_admin_panel')],
      ]) }
    );
  });

  bot.action(/^ref_admin_rate:(\d+(?:\.\d+)?)$/, adminOnly(), async (ctx) => {
    const rate = Number(ctx.match[1]);
    if (!Number.isFinite(rate) || rate < 0 || rate > 50) return ctx.answerCbQuery('Rate must be 0–50%', { show_alert: true });
    await SystemStatus.set({ referralCommissionRate: rate }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_COMMISSION_RATE', null, 'System', { rate });
    await ctx.answerCbQuery(`Commission rate ${rate}%`);
    return ctx.editMessageText(`✅ Referral commission rate: *${rate}%*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Commission Settings', 'ref_admin_settings')]]) });
  });

  bot.action(/^ref_admin_mode:(first|every)$/, adminOnly(), async (ctx) => {
    const mode = ctx.match[1];
    await SystemStatus.set({ referralCommissionMode: mode }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_COMMISSION_MODE', null, 'System', { mode });
    await ctx.answerCbQuery('Commission mode updated');
    return ctx.editMessageText(`✅ Commission mode: *${mode === 'every' ? 'Every top-up' : 'First top-up only'}*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Commission Settings', 'ref_admin_settings')]]) });
  });

  bot.action('ref_admin_tiers', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.get();
    const tiers = status.referralTiers?.length ? status.referralTiers : DEFAULT_TIERS;
    const lines = tiers.map((t) => `${t.emoji} *${t.label}*: ${t.minRefs}+ refs → *${t.rate}%*`).join('\\n');
    return ctx.editMessageText(`🏆 *Referral Tier Settings*\\n\\n${lines}\\n\\nPreset တစ်ခုရွေးပါ။`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('🥉 Default 2/3/5%', 'ref_admin_tier_preset:default')],
      [Markup.button.callback('⚡ Fast 3/5/8%', 'ref_admin_tier_preset:fast')],
      [Markup.button.callback('💎 Premium 2/5/10%', 'ref_admin_tier_preset:premium')],
      [Markup.button.callback('↩️ Referral Manager', 'ref_admin_panel')],
    ]) });
  });

  bot.action(/^ref_admin_tier_preset:(default|fast|premium)$/, adminOnly(), async (ctx) => {
    const presets = {
      default: DEFAULT_TIERS,
      fast: [{ minRefs: 1, rate: 3, label: 'Bronze', emoji: '🥉' }, { minRefs: 4, rate: 5, label: 'Silver', emoji: '🥈' }, { minRefs: 10, rate: 8, label: 'Gold', emoji: '🥇' }],
      premium: [{ minRefs: 1, rate: 2, label: 'Bronze', emoji: '🥉' }, { minRefs: 5, rate: 5, label: 'Silver', emoji: '🥈' }, { minRefs: 12, rate: 10, label: 'Gold', emoji: '🥇' }],
    };
    const tiers = presets[ctx.match[1]];
    await SystemStatus.set({ referralTiers: tiers }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_REFERRAL_TIERS', null, 'System', { preset: ctx.match[1], tiers });
    await ctx.answerCbQuery('Tier preset saved');
    return ctx.editMessageText(`✅ Referral tier preset saved: *${ctx.match[1]}*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Tier Settings', 'ref_admin_tiers')]]) });
  });

  async function sendFraudReview(ctx, edit = false) {
    const flags = await FraudFlag.find({ resolved: false }).sort({ severity: 1, createdAt: -1 }).limit(15).lean();
    if (!flags.length) {
      const empty = '✅ *Fraud Review*\\n\\nUnresolved fraud flag မရှိပါ။';
      return edit ? ctx.editMessageText(empty, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Referral Manager', 'ref_admin_panel')]]) }) : ctx.reply(empty, { parse_mode: 'Markdown' });
    }
    const icons = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡' };
    const rows = [];
    for (const flag of flags) {
      rows.push([Markup.button.callback(`${icons[flag.severity] || '⚪'} ${flag.type} #${String(flag._id).slice(-5)}`, 'ref_fraud_noop')]);
      rows.push([
        Markup.button.callback('🚫 Block Referrer', `fraud_block:${flag.referrerTid}`),
        Markup.button.callback('🚫 Block Referee', `fraud_block:${flag.refereeTid}`),
      ]);
      if (flag.referralId) rows.push([Markup.button.callback('🔓 Release Referral', `fraud_unfreeze:${flag.referralId}`)]);
      rows.push([Markup.button.callback('✅ Dismiss', `fraud_dismiss:${flag._id}`)]);
    }
    rows.push([Markup.button.callback('↩️ Referral Manager', 'ref_admin_panel')]);
    const text = `🛡 *Fraud Review*\\n\\n${flags.map((f) => `${icons[f.severity] || '⚪'} *${f.type}*\\nReferrer: \`${f.referrerTid}\` → Referee: \`${f.refereeTid}\``).join('\\n\\n')}`;
    return edit ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }) : ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  bot.action('ref_admin_fraud_rules', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const status = await SystemStatus.get();
    const text =
      `🛠 *Referral Fraud Rules*\\n\\n` +
      `⚡ Velocity limit: *${status.referralVelocityLimit || 10}/hour*\\n` +
      `🆕 New-account window: *${status.referralNewAccountWindowMinutes ?? 10} minutes*\\n` +
      `⏱ Rapid top-up window: *${status.referralRapidTopupSeconds ?? 120} seconds*\\n\\n` +
      `Preset button တစ်ခုနှိပ်ပြီး ချက်ချင်းသိမ်းပါ။`;
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('⚡ 5 refs/hour', 'ref_admin_rule:velocity:5'), Markup.button.callback('⚡ 10 refs/hour', 'ref_admin_rule:velocity:10'), Markup.button.callback('⚡ 20 refs/hour', 'ref_admin_rule:velocity:20')],
      [Markup.button.callback('🆕 0 min', 'ref_admin_rule:newWindow:0'), Markup.button.callback('🆕 10 min', 'ref_admin_rule:newWindow:10'), Markup.button.callback('🆕 30 min', 'ref_admin_rule:newWindow:30')],
      [Markup.button.callback('⏱ Off', 'ref_admin_rule:rapid:0'), Markup.button.callback('⏱ 2 min', 'ref_admin_rule:rapid:120'), Markup.button.callback('⏱ 5 min', 'ref_admin_rule:rapid:300')],
      [Markup.button.callback('↩️ Referral Manager', 'ref_admin_panel')],
    ]) });
  });

  bot.action(/^ref_admin_rule:(velocity|newWindow|rapid):(\d+)$/, adminOnly(), async (ctx) => {
    const type = ctx.match[1];
    const value = Number(ctx.match[2]);
    const field = type === 'velocity' ? 'referralVelocityLimit' : type === 'newWindow' ? 'referralNewAccountWindowMinutes' : 'referralRapidTopupSeconds';
    const limits = { referralVelocityLimit: [1, 1000], referralNewAccountWindowMinutes: [0, 1440], referralRapidTopupSeconds: [0, 86400] };
    const [min, max] = limits[field];
    if (value < min || value > max) return ctx.answerCbQuery('Invalid rule value', { show_alert: true });
    await SystemStatus.set({ [field]: value }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_REFERRAL_FRAUD_RULE', null, 'System', { field, value });
    await ctx.answerCbQuery('Fraud rule saved');
    return ctx.editMessageText(`✅ Fraud rule updated.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Fraud Rules', 'ref_admin_fraud_rules')]]) });
  });

  bot.action('ref_admin_fraud', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return sendFraudReview(ctx, true);
  });
  bot.action('ref_fraud_noop', requireRole('MANAGER'), (ctx) => ctx.answerCbQuery('ရွေးထားသော fraud flag ကို အောက်က action နဲ့ စီမံပါ။'));

  const referralHandler = async (ctx) => {
    try {
      const stats = await getStats(ctx.from.id);

      if (!stats.referralEnabled) {
        return ctx.reply('⏸ The referral program is currently paused. Check back soon!');
      }

      const modeStr = modeLabel(stats.commissionMode, stats.commissionType);

      const recentLines = stats.recentReferrals.length
        ? stats.recentReferrals.map((r) => {
            const icon = STATUS_ICON[r.status] || '•';
            const earned = r.earned > 0 ? ` — +${r.earned.toLocaleString()} MC` : '';
            const fraud  = r.isFraud ? ' 🔒' : '';
            return `  ${icon} ${r.maskedName}${earned}${fraud}`;
          }).join('\n')
        : '  _No referrals yet — share your link below!_';

      const text =
        `🔗 *Referral Program*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `📊 *Your Stats*\n` +
        `  👥 Total Referrals: *${stats.total}*\n` +
        `  ✅ Completed: *${stats.completed}*\n` +
        `  🔄 Active: *${stats.active}*\n` +
        `  ⏳ Pending: *${stats.pending}*\n` +
        (stats.frozen > 0 ? `  🔒 Frozen (fraud review): *${stats.frozen}*\n` : '') +
        `\`──────────────────────\`\n` +
        `🪙 *Total Earned:* *${(stats.totalCoinsEarned).toLocaleString()} MC*\n` +
        (stats.totalKSEarned > 0 ? `💰 *Legacy KS Earned:* *${(stats.totalKSEarned).toLocaleString()} KS*\n` : '') +
        `\`──────────────────────\`\n` +
        `🎯 *Commission:* ${stats.commissionRate}% per top-up\n` +
        `📋 *Mode:* ${modeStr}\n` +
        buildTierProgress(stats) +
        `\`──────────────────────\`\n` +
        `🎁 *Your Friend Gets:* +${stats.welcomeBonus.coins.toLocaleString()} MC\n` +
        `\`──────────────────────\`\n` +
        `*Recent Referrals:*\n${recentLines}\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `🔗 *Your Link:*\n\`${stats.link}\``;

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url(
            '📤 Share Invite',
            `https://t.me/share/url?url=${encodeURIComponent(stats.link)}&text=${encodeURIComponent(buildShareText(stats))}`
          )],
          [
            Markup.button.callback('🏆 Leaderboard',   'ref_leaderboard'),
            Markup.button.callback('🔄 Refresh',       'ref_refresh'),
          ],
        ]),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  };

  bot.command('referral', referralHandler);
  bot.hears(['👥 Referral', '👥 မိတ်ဆက်'], referralHandler);

  // ── /reflink — quick shareable invite ────────────────────────────────────────

  bot.command('reflink', async (ctx) => {
    try {
      const stats = await getStats(ctx.from.id);

      if (!stats.referralEnabled) {
        return ctx.reply('⏸ Referral program is currently paused.');
      }

      const inviteText = buildShareText(stats);

      await ctx.reply(
        `🔗 *Your Referral Link*\n\n` +
        `\`${stats.link}\`\n\n` +
        `*Preview of what your friends see:*\n` +
        `\`─────────────────────────\`\n` +
        inviteText +
        `\`─────────────────────────\`\n\n` +
        `_You earn *${stats.commissionRate}%* of every top-up they make_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url(
              '📤 Share Now',
              `https://t.me/share/url?url=${encodeURIComponent(stats.link)}&text=${encodeURIComponent(inviteText)}`
            )],
          ]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /reflead — public leaderboard ────────────────────────────────────────────

  bot.command('reflead', async (ctx) => {
    const board = await getLeaderboard(10);
    if (!board.length) return ctx.reply('🏆 No referrals completed yet. Be the first!');

    const medal = ['🥇', '🥈', '🥉'];
    const lines = board.map((entry, i) => {
      const tag = entry.user.username ? `@${entry.user.username}` : `User ${entry.user.telegramId}`;
      const m = medal[i] || `${i + 1}.`;
      return `${m} ${tag} — *${entry.count}* refs — ${(((entry.totalCoins || 0) + (entry.totalKS || 0))).toLocaleString()} MC earned`;
    });

    await ctx.reply(
      `🏆 *Referral Leaderboard*\n\n${lines.join('\n')}\n\n` +
      `_Share your link with /reflink to climb the ranks!_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Inline: leaderboard ───────────────────────────────────────────────────────

  bot.action('ref_leaderboard', async (ctx) => {
    await ctx.answerCbQuery();
    const board = await getLeaderboard(10);
    if (!board.length) {
      return ctx.reply('🏆 No completed referrals yet!');
    }
    const medal = ['🥇', '🥈', '🥉'];
    const lines = board.map((entry, i) => {
      const tag = entry.user.username ? `@${entry.user.username}` : `User ${entry.user.telegramId}`;
      return `${medal[i] || `${i + 1}.`} ${tag} — *${entry.count}* refs — ${(((entry.totalCoins || 0) + (entry.totalKS || 0))).toLocaleString()} MC earned`;
    });
    await ctx.reply(`🏆 *Referral Leaderboard*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  // ── Inline: refresh stats ─────────────────────────────────────────────────────

  bot.action('ref_refresh', async (ctx) => {
    await ctx.answerCbQuery('Refreshing...');
    try {
      const stats = await getStats(ctx.from.id);
      await ctx.editMessageText(
        `🔄 *Stats Refreshed!*\n\n` +
        `✅ Completed: *${stats.completed}* | 🔄 Active: *${stats.active}* | ⏳ Pending: *${stats.pending}*\n` +
        `🪙 Total Earned: *${(stats.totalCoinsEarned).toLocaleString()} MC*\n` +
        `📋 Commission: *${stats.commissionRate}%* (${stats.commissionMode === 'every' ? 'every top-up' : 'first top-up'})`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Again', 'ref_refresh')],
          ]),
        }
      );
    } catch (err) {
      await ctx.answerCbQuery('Error: ' + err.message);
    }
  });

  // ── Admin: /setreftiers ───────────────────────────────────────────────────────
  // Usage: /setreftiers 1:2 6:3 16:5

  bot.command('setreftiers', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (!args.length) {
      const status = await SystemStatus.get();
      const tiers  = status.referralTiers?.length ? status.referralTiers : DEFAULT_TIERS;
      const lines  = tiers.map((t) => `  ${t.emoji} *${t.label}*: ${t.minRefs}+ referrals → *${t.rate}%*`).join('\n');
      return ctx.reply(
        `📊 *Referral Commission Tiers*\n\n${lines}\n\n` +
        `Usage: \`/setreftiers 1:2 6:3 16:5\`\n` +
        `Format: \`minRefs:rate\` pairs (1–4 tiers)\n\n` +
        `_Example:_ \`/setreftiers 1:2 5:3 10:4 20:6\``,
        { parse_mode: 'Markdown' }
      );
    }

    const LABELS = [
      { label: 'Bronze',  emoji: '🥉' },
      { label: 'Silver',  emoji: '🥈' },
      { label: 'Gold',    emoji: '🥇' },
      { label: 'Diamond', emoji: '💎' },
    ];

    const tiers = [];
    for (const arg of args.slice(0, 4)) {
      const [minStr, rateStr] = arg.split(':');
      const minRefs = Number(minStr);
      const rate    = Number(rateStr);
      if (isNaN(minRefs) || isNaN(rate) || minRefs < 1 || rate < 0 || rate > 100) {
        return ctx.reply(`❌ Invalid tier: \`${arg}\`\n\nFormat: \`minRefs:rate\` (e.g. \`6:3\`)`, { parse_mode: 'Markdown' });
      }
      const idx = tiers.length;
      tiers.push({ minRefs, rate, label: LABELS[idx]?.label || `Tier ${idx + 1}`, emoji: LABELS[idx]?.emoji || '🏅' });
    }

    // Validate ascending order
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].minRefs <= tiers[i - 1].minRefs) {
        return ctx.reply('❌ Tier `minRefs` values must be in ascending order.', { parse_mode: 'Markdown' });
      }
    }

    await SystemStatus.set({ referralTiers: tiers }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_REFERRAL_TIERS', null, 'System', { tiers });

    const lines = tiers.map((t) => `  ${t.emoji} *${t.label}*: ${t.minRefs}+ refs → *${t.rate}%*`).join('\n');
    await ctx.reply(
      `✅ *Referral Tiers Updated!*\n\n${lines}\n\n_Takes effect on the next commission payment._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /reftiers — show current tier table ────────────────────────────────

  bot.command('reftiers', requireRole('MANAGER'), async (ctx) => {
    const status = await SystemStatus.get();
    const tiers  = status.referralTiers?.length ? status.referralTiers : DEFAULT_TIERS;
    const lines  = tiers.map((t, i) => {
      const next = tiers[i + 1];
      const range = next ? `${t.minRefs}–${next.minRefs - 1} refs` : `${t.minRefs}+ refs`;
      return `  ${t.emoji} *${t.label}*: ${range} → *${t.rate}%* commission`;
    }).join('\n');

    await ctx.reply(
      `📊 *Referral Commission Tier Table*\n\n${lines}\n\n` +
      `_Use /setreftiers to configure._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /refstats ──────────────────────────────────────────────────────────

  bot.command('refstats', requireRole('MANAGER'), async (ctx) => {
    const status = await SystemStatus.get();

    const [total, completed, active, pending, frozen, flagged] = await Promise.all([
      Referral.countDocuments({}),
      Referral.countDocuments({ status: 'Completed' }),
      Referral.countDocuments({ status: 'Active' }),
      Referral.countDocuments({ status: 'Pending' }),
      Referral.countDocuments({ status: 'Frozen' }),
      FraudFlag.countDocuments({ resolved: false }),
    ]);

    const agg = await Referral.aggregate([
      { $match: { bonusPaid: true } },
      { $group: { _id: null, totalKS: { $sum: '$totalCommissionKS' }, totalCoins: { $sum: '$totalCommissionCoins' } } },
    ]);
    const totalKSPaid   = agg[0]?.totalKS || 0;
    const totalCoinsPaid = agg[0]?.totalCoins || 0;

    const board = await getLeaderboard(5);
    const topLines = board.map((e, i) => {
      const tag = e.user.username ? `@${e.user.username}` : `ID:${e.user.telegramId}`;
      return `  ${i + 1}. ${tag} — ${e.count} refs — ${(((e.totalCoins || 0) + (e.totalKS || 0))).toLocaleString()} MC`;
    }).join('\n') || '  _None yet_';

    await ctx.reply(
      `📊 *Referral System Stats*\n` +
      `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
      `*Program:* ${status.referralEnabled ? '🟢 Active' : '🔴 Paused'}\n` +
      `*Commission:* ${status.referralCommissionRate}% • ${modeLabel(status.referralCommissionMode, status.referralCommissionType)}\n` +
      `*Min Topup:* ${(status.referralMinTopup || 1000).toLocaleString()} KS\n` +
      `\`──────────────────────\`\n` +
      `👥 Total Referrals: *${total}*\n` +
      `✅ Completed: *${completed}*\n` +
      `🔄 Active (earning): *${active}*\n` +
      `⏳ Pending: *${pending}*\n` +
      `🔒 Frozen (fraud): *${frozen}*\n` +
      `⚠️ Unresolved Fraud Flags: *${flagged}*\n` +
      `🪙 Total Paid Out: *${totalCoinsPaid.toLocaleString()} MC*\n` +
      (totalKSPaid > 0 ? `💰 Legacy KS Paid Out: *${price(totalKSPaid)}*\n` : '') +
      `\`──────────────────────\`\n` +
      `🏆 *Top 5 Referrers:*\n${topLines}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚠️ View Fraud Flags', 'ref_fraud_list')],
        ]),
      }
    );
  });

  // ── Admin: /setcommission ─────────────────────────────────────────────────────
  // Usage: /setcommission <rate> [first|every] [KS|Coin|Both]
  // e.g.:  /setcommission 3 every KS

  bot.command('setcommission', adminOnly(), async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);

    if (!parts.length) {
      const status = await SystemStatus.get();
      return ctx.reply(
        `💡 *Current Commission Settings*\n\n` +
        `Rate: *${status.referralCommissionRate}%*\n` +
        `Mode: *${status.referralCommissionMode}*\n` +
        `Type: *${status.referralCommissionType}*\n` +
        `Min Topup: *${(status.referralMinTopup || 1000).toLocaleString()} KS*\n` +
        `Program: *${status.referralEnabled ? 'Active' : 'Paused'}*\n\n` +
        `Usage: \`/setcommission <rate%> [first|every] [KS|Coin|Both]\`\n` +
        `Example: \`/setcommission 3 every KS\``,
        { parse_mode: 'Markdown' }
      );
    }

    const rate = parseFloat(parts[0]);
    if (isNaN(rate) || rate < 0 || rate > 50) {
      return ctx.reply('❌ Rate must be a number between 0 and 50.');
    }

    const mode = parts[1] ? parts[1].toLowerCase() : null;
    const type = parts[2] ? parts[2] : null;

    const updates = { referralCommissionRate: rate };
    if (mode && ['first', 'every'].includes(mode)) updates.referralCommissionMode = mode;
    if (type && ['KS', 'Coin', 'Both'].includes(type)) updates.referralCommissionType = type;

    await SystemStatus.set(updates, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_COMMISSION_RATE', null, 'System', updates);

    const status = await SystemStatus.get();
    await ctx.reply(
      `✅ *Commission Updated!*\n\n` +
      `Rate: *${status.referralCommissionRate}%*\n` +
      `Mode: *${status.referralCommissionMode}*\n` +
      `Type: *${status.referralCommissionType}*\n\n` +
      `_Takes effect on the next top-up approval._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /togglereferral — enable / disable program ────────────────────────

  bot.command('togglereferral', adminOnly(), async (ctx) => {
    const status = await SystemStatus.get();
    const newState = !status.referralEnabled;
    await SystemStatus.set({ referralEnabled: newState }, ctx.from.id);
    await auditLog(ctx.from.id, newState ? 'REFERRAL_ENABLED' : 'REFERRAL_DISABLED', null, 'System', {});

    await ctx.reply(
      newState
        ? '🟢 *Referral program is now ACTIVE.*'
        : '🔴 *Referral program is now PAUSED.*\n_No new commissions will be paid until re-enabled._',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin: /refadjust <telegramId> <+/-amount> [note] ────────────────────────

  bot.command('refadjust', adminOnly(), async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);

    if (parts.length < 2) {
      return ctx.reply(
        `💡 *Manual Referral Commission Adjustment*\n\n` +
        `Usage: \`/refadjust <telegramId> <+/-amount> [reason]\`\n\n` +
        `Examples:\n` +
        `\`/refadjust 123456789 +500 compensation for bug\`\n` +
        `\`/refadjust 123456789 -200 reversal\``,
        { parse_mode: 'Markdown' }
      );
    }

    const targetTid = Number(parts[0]);
    const amount    = Number(parts[1]);
    const note      = parts.slice(2).join(' ') || 'Manual admin adjustment';

    if (isNaN(targetTid) || isNaN(amount) || amount === 0) {
      return ctx.reply('❌ Invalid user ID or amount.');
    }

    try {
      await adminAdjustCommission(ctx.from.id, targetTid, amount, note);
      const user = await User.findByTelegramId(targetTid);

      await ctx.reply(
        `✅ *Commission Adjusted*\n\n` +
        `👤 User: \`${targetTid}\`${user?.username ? ` (@${user.username})` : ''}\n` +
        `💰 Amount: *${amount > 0 ? '+' : ''}${amount.toLocaleString()} KS*\n` +
        `📝 Note: ${note}`,
        { parse_mode: 'Markdown' }
      );

      // Notify user
      try {
        await ctx.telegram.sendMessage(
          targetTid,
          amount > 0
            ? `🎁 *Referral Bonus Added!*\n\n*+${amount.toLocaleString()} KS* has been added to your wallet.\n_${note}_`
            : `📝 *Account Adjustment*\n\n*${amount.toLocaleString()} KS* has been adjusted from your referral earnings.\n_${note}_`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Admin: /reffraud — view unresolved fraud flags ────────────────────────────

  bot.command('reffraud', requireRole('MANAGER'), async (ctx) => {
    const flags = await FraudFlag.find({ resolved: false })
      .sort({ severity: 1, createdAt: -1 })
      .limit(15);

    if (!flags.length) {
      return ctx.reply('✅ No unresolved fraud flags. All clear!');
    }

    const severityIcon = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡' };
    const lines = flags.map((f, i) => {
      const icon  = severityIcon[f.severity] || '⚪';
      const label = f.type.replace(/_/g, ' ');
      const age   = Math.floor((Date.now() - f.createdAt.getTime()) / 60_000);
      return `${i + 1}. ${icon} *${label}*\n   Referrer: \`${f.referrerTid}\` → Referee: \`${f.refereeTid}\`\n   _${age}m ago_`;
    });

    await ctx.reply(
      `⚠️ *Unresolved Fraud Flags (${flags.length})*\n\n` +
      lines.join('\n\n') + '\n\n' +
      `_Use [🚫 Block] / [✅ Dismiss] buttons in each alert to resolve._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Inline: fraud flag list from /refstats ────────────────────────────────────

  bot.action('ref_fraud_list', requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    return sendFraudReview(ctx);
  });

  // ── Register fraud action handlers (block / dismiss buttons) ─────────────────
  registerFraudActions(bot);
};
