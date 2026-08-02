/**
 * outlineUser.js — Outline VPN user entry point.
 *
 * "🌐 Outline VPN" button နှိပ်ပါက SystemStatus မှ outlineBotUsername ကြည့်ပြီး
 * VPN bot ဆီ redirect လုပ်ပေးသည်။
 *
 * Button သည် username မသတ်မှတ်မချင်း user keyboard တွင် ပေါ်မည်မဟုတ်
 * (keyboard.js mainMenuKeyboard တွင် conditional ဖြစ်သည်)။
 */

const SystemStatus = require('../models/SystemStatus');

module.exports = function register(bot) {
  bot.hears('🌐 Outline VPN', async (ctx) => {
    let username = null;
    try {
      const status = await SystemStatus.get();
      username = status.outlineBotUsername || null;
    } catch (_) {}

    if (!username) {
      // Username မသတ်မှတ်ရသေး — ပြမည်မဟုတ် (button မပေါ်သင့်ပါ)
      return ctx.reply('🌐 Outline VPN ဝန်ဆောင်မှုကို မကြာမီ ရရှိနိုင်မည်ဖြစ်သည်။');
    }

    await ctx.reply(
      `🌐 *Outline VPN*\n\n` +
      `VPN Key ရယူရန် ကျွန်ုပ်တို့၏ VPN bot သို့ သွားပါ:\n\n` +
      `👉 @${username}`,
      { parse_mode: 'Markdown' }
    );
  });
};
