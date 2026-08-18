/**
 * ChannelHealthService — validates configured Telegram channels.
 *
 * The check is intentionally read-only: it verifies that the bot can resolve
 * the channel and still has the permissions required by its configured roles.
 */
const { getKnownChannels } = require('./ChannelRegistryService');

const POSTING_ROLES = new Set(['announce', 'autopost', 'livefeed', 'backup', 'review']);

function classifyError(error) {
  const description = String(error?.response?.description || error?.message || '').toLowerCase();
  if (description.includes('chat not found')) return 'chat_not_found';
  if (description.includes('forbidden')) return 'bot_forbidden';
  return 'telegram_error';
}

async function checkConfiguredChannels(telegram) {
  const channels = await getKnownChannels();
  const me = await telegram.getMe();
  const results = [];

  for (const channel of channels) {
    const needsPosting = channel.sources.some((source) => POSTING_ROLES.has(source));
    const result = {
      chatId: String(channel.chatId),
      title: channel.title || String(channel.chatId),
      sources: channel.sources,
      ok: false,
      code: 'unknown',
      detail: '',
    };

    try {
      const chat = await telegram.getChat(channel.chatId);
      if (chat.type !== 'channel') {
        result.code = 'not_channel';
        result.detail = `Telegram returned chat type ${chat.type}`;
        results.push(result);
        continue;
      }

      const member = await telegram.getChatMember(channel.chatId, me.id);
      if (!['administrator', 'creator'].includes(member.status)) {
        result.code = 'bot_not_admin';
        result.detail = `Bot status is ${member.status}`;
        results.push(result);
        continue;
      }
      if (needsPosting && member.status === 'administrator' && member.can_post_messages === false) {
        result.code = 'cannot_post';
        result.detail = 'Bot is an admin but cannot post messages';
        results.push(result);
        continue;
      }

      result.ok = true;
      result.code = 'ok';
      result.detail = needsPosting ? 'Readable and can post' : 'Readable and accessible';
    } catch (error) {
      result.code = classifyError(error);
      result.detail = String(error?.response?.description || error?.message || 'Telegram request failed');
    }
    results.push(result);
  }

  return {
    checked: results.length,
    healthy: results.filter((result) => result.ok).length,
    unhealthy: results.filter((result) => !result.ok).length,
    results,
  };
}

module.exports = { checkConfiguredChannels, classifyError };
