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

test('daily schedules recover to the next MMT occurrence', () => {
  // 03:04 UTC = 09:34 MMT, so 09:00 MMT has already passed.
  const from = new Date('2030-01-02T03:04:05.000Z');
  assert.equal(
    nextRunAt({ frequency: 'daily', localHour: 9, localMinute: 0 }, from).toISOString(),
    '2030-01-03T02:30:00.000Z',
  );
});

test('daily schedules keep a later same-day MMT time', () => {
  // 02:00 UTC = 08:30 MMT, so 09:00 MMT is still due today.
  const from = new Date('2030-01-02T02:00:00.000Z');
  assert.equal(
    nextRunAt({ frequency: 'daily', localHour: 9, localMinute: 0 }, from).toISOString(),
    '2030-01-02T02:30:00.000Z',
  );
});

test('weekly schedules honor the selected MMT weekday', () => {
  const from = new Date('2030-01-02T00:00:00.000Z'); // Wednesday MMT
  assert.equal(
    nextRunAt({ frequency: 'weekly', weekdays: [5], localHour: 9, localMinute: 0 }, from).toISOString(),
    '2030-01-04T02:30:00.000Z',
  );
});
