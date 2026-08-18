const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyError } = require('../src/services/ChannelHealthService');
const { isWithinWindow, buildText } = require('../src/services/ChannelAutoPostService');

test('channel health classifies Telegram access failures', () => {
  assert.equal(classifyError({ response: { description: 'Bad Request: chat not found' } }), 'chat_not_found');
  assert.equal(classifyError({ response: { description: 'Forbidden: bot was kicked' } }), 'bot_forbidden');
  assert.equal(classifyError(new Error('network timeout')), 'telegram_error');
});

test('auto-post schedule window handles normal and midnight slots', () => {
  assert.equal(isWithinWindow({ scheduledHour: 10, scheduledMinute: 20 }, { hour: 10, min: 20 }), true);
  assert.equal(isWithinWindow({ scheduledHour: 10, scheduledMinute: 20 }, { hour: 10, min: 29 }), true);
  assert.equal(isWithinWindow({ scheduledHour: 10, scheduledMinute: 20 }, { hour: 10, min: 30 }), false);
  assert.equal(isWithinWindow({ scheduledHour: 23, scheduledMinute: 55 }, { hour: 0, min: 4 }), true);
});

test('auto-post body includes optional title', () => {
  assert.equal(buildText({ title: 'Sale', body: 'Today only' }), '*Sale*\n\nToday only');
  assert.equal(buildText({ title: '', body: 'Announcement' }), 'Announcement');
});
