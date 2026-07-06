/**
 * Address Book Commands
 *
 * /myids — view all saved game IDs
 * /saveid — save a new game ID
 * /deleteid — delete a saved ID
 */

const { Markup } = require('telegraf');
const { getEntries, saveEntry, deleteEntry, setDefault, formatEntry } = require('../services/AddressBookService');
const { t } = require('../utils/i18n');
const AddressBook = require('../models/AddressBook');
const User = require('../models/User');

module.exports = function registerAddressBook(bot) {

  const myIdsHandler = async (ctx) => {
    const entries = await getEntries(ctx.from.id);
    if (!entries.length) {
      return ctx.reply(
        `${t(ctx, 'gameids.title')}\n\n${t(ctx, 'gameids.empty')}\n\n_Example: /saveid MobileLegends 123456 9001 "My Main"_`,
        { parse_mode: 'Markdown' }
      );
    }

    const byGame = {};
    for (const e of entries) {
      if (!byGame[e.gameName]) byGame[e.gameName] = [];
      byGame[e.gameName].push(e);
    }

    const lines = [];
    for (const [game, ids] of Object.entries(byGame)) {
      lines.push(`*${game}:*`);
      ids.forEach((e, i) => {
        lines.push(`  ${i + 1}. ${e.isDefault ? '⭐ ' : ''}${formatEntry(e)}${e.nickname !== e.gameId ? ` _(${e.nickname})_` : ''}`);
      });
    }

    const addBtn = ctx.user?.language === 'mm' ? '➕ ID အသစ်ထည့်' : '➕ Save New ID';
    const delBtn = ctx.user?.language === 'mm' ? '🗑 ID ဖျက်'     : '🗑 Delete an ID';
    await ctx.reply(
      `${t(ctx, 'gameids.title')} (${entries.length})\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(addBtn, 'ab_start_save')],
          [Markup.button.callback(delBtn, 'ab_start_delete')],
        ]),
      }
    );
  };

  bot.command('myids', myIdsHandler);
  bot.hears(['📖 My Game IDs', '📖 ဂိမ်း ID များ'], myIdsHandler);

  // ── /saveid <Game> <GameID> [ZoneID] ["Nickname"] ──────────────────────────
  bot.command('saveid', async (ctx) => {
    const { t } = require('../utils/i18n');
    const text = ctx.message.text.slice('/saveid'.length).trim();
    if (!text) {
      return ctx.reply(
        `${t(ctx, 'gameids.save_title')}\n\n${t(ctx, 'gameids.save_format')}`,
        { parse_mode: 'Markdown' }
      );
    }

    const parts = text.match(/[^\s"']+|"([^"]*)"|\`([^`]*)\`/g)?.map((p) => p.replace(/^["'`]|["'`]$/g, '')) || [];

    if (parts.length < 2) {
      return ctx.reply(t(ctx, 'gameids.min_args'), { parse_mode: 'Markdown' });
    }

    const [gameName, gameId, ...rest] = parts;
    const hasZone = rest.length && /^\d+$/.test(rest[0]);
    const zoneId   = hasZone ? rest[0] : null;
    const nickname = rest[hasZone ? 1 : 0] || null;

    try {
      const entry = await saveEntry(ctx.from.id, { gameName, gameId, zoneId, nickname });
      await ctx.reply(
        `${t(ctx, 'gameids.saved')}\n\n` +
        `🎮 ${t(ctx, 'gameids.game')}: *${entry.gameName}*\n` +
        `🆔 ${t(ctx, 'gameids.id')}: \`${entry.gameId}\`` +
        (entry.zoneId ? `\n🗺 ${t(ctx, 'gameids.zone')}: \`${entry.zoneId}\`` : '') +
        (entry.nickname !== entry.gameId ? `\n📝 ${t(ctx, 'gameids.label')}: *${entry.nickname}*` : '') +
        `\n${entry.isDefault ? `\n${t(ctx, 'gameids.default_set')}` : ''}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Inline: start save flow ────────────────────────────────────────────────
  bot.action('ab_start_save', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingSaveId = true;
    await ctx.reply(
      `📖 *Save a Game ID*\n\nFormat: \`GameName GameID [ZoneID] [Nickname]\`\nExample: \`MobileLegends 123456 9001 MyMain\`\n\nType your entry now:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'ab_cancel_save')]]),
      }
    );
  });

  bot.action('ab_cancel_save', async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    ctx.session.awaitingSaveId = false;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  // Capture free-form save input from inline button
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.awaitingSaveId) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    ctx.session.awaitingSaveId = false;

    const parts = ctx.message.text.trim().match(/[^\s"']+|"([^"]*)"|\`([^`]*)\`/g)
      ?.map((p) => p.replace(/^["'`]|["'`]$/g, '')) || [];
    if (parts.length < 2) return ctx.reply('❌ Need at least Game and ID. Try again from 📖 My Game IDs.');

    const [gameName, gameId, ...rest] = parts;
    const hasZone = rest.length && /^\d+$/.test(rest[0]);
    const zoneId   = hasZone ? rest[0] : null;
    const nickname = rest[hasZone ? 1 : 0] || null;

    try {
      const entry = await saveEntry(ctx.from.id, { gameName, gameId, zoneId, nickname });
      await ctx.reply(
        `✅ Saved: *${entry.gameName}* — \`${entry.gameId}\`` +
        (entry.zoneId ? ` (Zone ${entry.zoneId})` : ''),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('📖 My Game IDs', 'ab_view_all')]]),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action('ab_view_all', async (ctx) => {
    await ctx.answerCbQuery();
    return myIdsHandler(ctx);
  });

  // ── Inline: start delete flow ──────────────────────────────────────────────
  bot.action('ab_start_delete', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return;

    const entries = await AddressBook.find({ userId: user._id });
    if (!entries.length) return ctx.reply('No saved IDs to delete.');

    const buttons = entries.map((e) => [
      Markup.button.callback(
        `🗑 ${e.gameName}: ${formatEntry(e)}`,
        `ab_delete:${e._id}`
      ),
    ]);

    await ctx.reply('Select an ID to delete:', {
      ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('❌ Cancel', 'ab_cancel')]]),
    });
  });

  bot.action(/^ab_delete:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const entryId = ctx.match[1];
    try {
      const entry = await deleteEntry(ctx.from.id, entryId);
      await ctx.editMessageText(`✅ Deleted: ${entry.gameName} — ${entry.gameId}`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action('ab_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  // ── /deleteid ──────────────────────────────────────────────────────────────
  bot.command('deleteid', async (ctx) => {
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return;

    const entries = await AddressBook.find({ userId: user._id });
    if (!entries.length) return ctx.reply('📖 No saved IDs to delete.');

    const buttons = entries.map((e) => [
      Markup.button.callback(
        `🗑 ${e.gameName}: ${formatEntry(e)}`,
        `ab_delete:${e._id}`
      ),
    ]);

    await ctx.reply('Select an ID to delete:', {
      ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('❌ Cancel', 'ab_cancel')]]),
    });
  });
};
