/**
 * Banner Admin — Promotion banner management
 *
 * Admin commands (MANAGER+):
 *   /banners             — list all banners
 *   /addbanner           — start add flow (multi-step)
 *   /editbanner <id>     — edit banner
 *   /deletebanner <id>   — delete banner
 *   /togglebanner <id>   — enable/disable banner
 *
 * Inline callbacks:
 *   banner_toggle:<id>   — toggle active/inactive
 *   banner_delete:<id>   — delete with confirmation
 *   banner_del_confirm:<id>
 */

const { Markup } = require('telegraf');
const { requireRole } = require('../middlewares/adminCheck');
const Banner   = require('../models/Banner');
const { auditLog } = require('../services/logger');

function shortId(banner) {
  return banner._id.toString().slice(-6).toUpperCase();
}

function fmtBanner(b) {
  const status    = b.isActive ? '🟢 Active' : '🔴 Inactive';
  const targetStr = b.targetType !== 'none' ? `🎯 Target: ${b.targetType}${b.targetId ? ` (${b.targetId})` : ''}` : '';
  const dateStr   =
    b.startAt || b.endAt
      ? `📅 ${b.startAt ? b.startAt.toLocaleDateString('en-GB') : '∞'} → ${b.endAt ? b.endAt.toLocaleDateString('en-GB') : '∞'}`
      : '';
  return (
    `🏷 *${b.title}*\n` +
    `ID: \`${shortId(b)}\`  |  Priority: ${b.priority}  |  ${status}\n` +
    (b.subtitle ? `_${b.subtitle}_\n` : '') +
    (targetStr ? `${targetStr}\n` : '') +
    (dateStr ? `${dateStr}\n` : '') +
    (b.imageUrl ? `🖼 Image: set\n` : '')
  );
}

function bannerKeyboard(banner) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        banner.isActive ? '🔴 Disable' : '🟢 Enable',
        `banner_toggle:${banner._id}`
      ),
      Markup.button.callback('🗑 Delete', `banner_delete:${banner._id}`),
    ],
  ]);
}

module.exports = function registerBannerAdmin(bot) {

  // ── /banners ───────────────────────────────────────────────────────────────

  bot.command('banners', requireRole('MANAGER'), async (ctx) => {
    const banners = await Banner.find().sort({ priority: -1, createdAt: -1 }).limit(20);
    if (!banners.length) {
      return ctx.reply(
        `🏷 *Promotion Banners*\n\nNo banners yet.\n\nUse /addbanner to create one.`,
        { parse_mode: 'Markdown' }
      );
    }
    await ctx.reply(
      `🏷 *Promotion Banners* (${banners.length})\n\n` +
      `Use /addbanner, /editbanner, /deletebanner, /togglebanner`,
      { parse_mode: 'Markdown' }
    );
    for (const b of banners.slice(0, 10)) {
      await ctx.reply(fmtBanner(b), {
        parse_mode: 'Markdown',
        ...bannerKeyboard(b),
      });
    }
  });

  // ── /addbanner ─────────────────────────────────────────────────────────────

  bot.command('addbanner', requireRole('MANAGER'), async (ctx) => {
    const args = ctx.message.text.split('\n').slice(1);
    if (!args.length || !args[0]?.trim()) {
      return ctx.reply(
        `🏷 *Add Banner*\n\n` +
        `Format (one field per line):\n` +
        `\`\`\`\n/addbanner\nTitle Here\nOptional subtitle\nimage_url (or - to skip)\ntargetType (shop|category|product|url|none)\ntargetId (or - to skip)\nbuttonText (or - to skip)\npriority (number)\n\`\`\`\n\n` +
        `Example:\n` +
        `\`/addbanner\nSummer Sale!\n50% off selected items\nhttps://image.url/banner.jpg\nshop\n-\nShop Now\n10\``,
        { parse_mode: 'Markdown' }
      );
    }

    const [title, subtitle, imageRaw, targetTypeRaw, targetIdRaw, buttonTextRaw, priorityRaw] = args.map((a) => a.trim());

    if (!title) return ctx.reply('❌ Title is required.');

    const targetType = ['shop', 'category', 'product', 'url', 'none'].includes(targetTypeRaw)
      ? targetTypeRaw
      : 'none';

    const banner = await Banner.create({
      title,
      subtitle:   subtitle && subtitle !== '-' ? subtitle : null,
      imageUrl:   imageRaw && imageRaw !== '-' ? imageRaw : null,
      targetType,
      targetId:   targetIdRaw && targetIdRaw !== '-' ? targetIdRaw : null,
      buttonText: buttonTextRaw && buttonTextRaw !== '-' ? buttonTextRaw : null,
      priority:   Number(priorityRaw) || 0,
      isActive:   true,
      createdBy:  ctx.from.id,
    });

    await auditLog(ctx.from.id, 'BANNER_CREATED', null, 'Banner', { bannerId: banner._id, title });

    await ctx.reply(
      `✅ *Banner Created*\n\n${fmtBanner(banner)}`,
      { parse_mode: 'Markdown', ...bannerKeyboard(banner) }
    );
  });

  // ── /togglebanner <id> ─────────────────────────────────────────────────────

  bot.command('togglebanner', requireRole('MANAGER'), async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return ctx.reply('Usage: `/togglebanner <id>`', { parse_mode: 'Markdown' });

    const banner = await Banner.findOne({ _id: { $regex: new RegExp(idStr, 'i') } })
      .catch(() => null)
      || await Banner.findById(idStr).catch(() => null);

    if (!banner) return ctx.reply('❌ Banner not found. Use /banners to list IDs.');

    banner.isActive  = !banner.isActive;
    banner.updatedBy = ctx.from.id;
    await banner.save();

    await auditLog(ctx.from.id, banner.isActive ? 'BANNER_ENABLED' : 'BANNER_DISABLED', null, 'Banner', { bannerId: banner._id });
    await ctx.reply(
      `${banner.isActive ? '🟢' : '🔴'} Banner *${banner.title}* is now *${banner.isActive ? 'active' : 'inactive'}*.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /deletebanner <id> ────────────────────────────────────────────────────

  bot.command('deletebanner', requireRole('MANAGER'), async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return ctx.reply('Usage: `/deletebanner <id>`', { parse_mode: 'Markdown' });

    const banner = await Banner.findById(idStr).catch(() => null);
    if (!banner) return ctx.reply('❌ Banner not found.');

    await Banner.deleteOne({ _id: banner._id });
    await auditLog(ctx.from.id, 'BANNER_DELETED', null, 'Banner', { bannerId: banner._id, title: banner.title });
    await ctx.reply(`✅ Banner *${banner.title}* deleted.`, { parse_mode: 'Markdown' });
  });

  // ── Callback: banner_toggle:<id> ──────────────────────────────────────────

  bot.action(/^banner_toggle:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const bannerId = ctx.match[1];
    const banner = await Banner.findById(bannerId).catch(() => null);
    if (!banner) return ctx.answerCbQuery('Banner not found');

    banner.isActive  = !banner.isActive;
    banner.updatedBy = ctx.from.id;
    await banner.save();

    await ctx.editMessageText(fmtBanner(banner), {
      parse_mode: 'Markdown',
      ...bannerKeyboard(banner),
    });
  });

  // ── Callback: banner_delete:<id> ─────────────────────────────────────────

  bot.action(/^banner_delete:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery();
    const bannerId = ctx.match[1];
    const banner = await Banner.findById(bannerId).catch(() => null);
    if (!banner) return ctx.answerCbQuery('Banner not found');

    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Delete', `banner_del_confirm:${bannerId}`),
          Markup.button.callback('❌ Cancel', `banner_toggle:${bannerId}`),
        ],
      ]).reply_markup
    );
  });

  // ── Callback: banner_del_confirm:<id> ────────────────────────────────────

  bot.action(/^banner_del_confirm:(.+)$/, requireRole('MANAGER'), async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    const bannerId = ctx.match[1];
    const banner = await Banner.findByIdAndDelete(bannerId).catch(() => null);
    if (!banner) return;

    await auditLog(ctx.from.id, 'BANNER_DELETED', null, 'Banner', { bannerId, title: banner.title });
    await ctx.editMessageText(`🗑 Banner *${banner.title}* has been deleted.`, { parse_mode: 'Markdown' });
  });
};
