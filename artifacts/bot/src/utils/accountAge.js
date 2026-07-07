/**
 * accountAge — estimate a Telegram account's creation date from its numeric ID.
 * Telegram does NOT expose creation dates; IDs are assigned roughly sequentially,
 * so interpolating between known ID→date anchor points gives a usable estimate
 * (accuracy ± a few months). Good enough for anti-fraud minimum-age gates.
 */

const ANCHORS = [
  [1,          Date.UTC(2013, 7, 1)],
  [100000000,  Date.UTC(2016, 3, 1)],
  [200000000,  Date.UTC(2016, 7, 1)],
  [300000000,  Date.UTC(2017, 2, 1)],
  [400000000,  Date.UTC(2017, 9, 1)],
  [500000000,  Date.UTC(2018, 3, 1)],
  [600000000,  Date.UTC(2018, 8, 1)],
  [700000000,  Date.UTC(2019, 0, 1)],
  [800000000,  Date.UTC(2019, 5, 1)],
  [900000000,  Date.UTC(2019, 9, 1)],
  [1000000000, Date.UTC(2020, 1, 1)],
  [1200000000, Date.UTC(2020, 8, 1)],
  [1400000000, Date.UTC(2021, 2, 1)],
  [1600000000, Date.UTC(2021, 6, 1)],
  [1800000000, Date.UTC(2021, 11, 1)],
  [2000000000, Date.UTC(2022, 3, 1)],
  [2100000000, Date.UTC(2022, 5, 1)],
  [5000000000, Date.UTC(2022, 11, 1)],
  [5500000000, Date.UTC(2023, 4, 1)],
  [6000000000, Date.UTC(2023, 8, 1)],
  [6500000000, Date.UTC(2024, 1, 1)],
  [7000000000, Date.UTC(2024, 5, 1)],
  [7500000000, Date.UTC(2024, 10, 1)],
  [8000000000, Date.UTC(2025, 3, 1)],
];

/**
 * Estimated creation timestamp (ms) for a Telegram user ID, or null if unknown.
 */
function estimateCreationDate(telegramId) {
  const id = Number(telegramId);
  if (!id || id < 1) return null;
  if (id <= ANCHORS[0][0]) return ANCHORS[0][1];
  for (let i = 1; i < ANCHORS.length; i++) {
    if (id <= ANCHORS[i][0]) {
      const [id0, t0] = ANCHORS[i - 1];
      const [id1, t1] = ANCHORS[i];
      return t0 + ((id - id0) / (id1 - id0)) * (t1 - t0);
    }
  }
  // Newer than the last anchor — extrapolate but never into the future
  const [id0, t0] = ANCHORS[ANCHORS.length - 2];
  const [id1, t1] = ANCHORS[ANCHORS.length - 1];
  const est = t1 + ((id - id1) / (id1 - id0)) * (t1 - t0);
  return Math.min(est, Date.now());
}

/**
 * Estimated account age in whole days (0 if unknown/very new).
 */
function estimateAccountAgeDays(telegramId) {
  const created = estimateCreationDate(telegramId);
  if (!created) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 86400000));
}

module.exports = { estimateCreationDate, estimateAccountAgeDays };
