const assert = require('node:assert/strict');
const { test } = require('node:test');

const { nextRunAt } = require('../src/services/AnnouncementAutomationService');

test('once schedules keep their configured runAt time', () => {
  const runAt = new Date('2030-01-02T03:04:05.000Z');
  assert.equal(nextRunAt({ frequency: 'once', runAt }).getTime(), runAt.getTime());
});

test('hourly schedules run one hour after the previous tick', () => {
  const from = new Date('2030-01-02T03:04:05.000Z');
  assert.equal(
    nextRunAt({ frequency: 'hourly' }, from).getTime(),
    from.getTime() + 60 * 60 * 1000,
  );
});

test('six-hour schedules run six hours after the previous tick', () => {
  const from = new Date('2030-01-02T03:04:05.000Z');
  assert.equal(
    nextRunAt({ frequency: 'every_6_hours' }, from).getTime(),
    from.getTime() + 6 * 60 * 60 * 1000,
  );
});

test('custom intervals are clamped to the minimum supported interval', () => {
  const from = new Date('2030-01-02T03:04:05.000Z');
  assert.equal(
    nextRunAt({ frequency: 'interval', intervalMinutes: 30 }, from).getTime(),
    from.getTime() + 60 * 60 * 1000,
  );
});
