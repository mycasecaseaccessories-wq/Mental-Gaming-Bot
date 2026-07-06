const axios = require('axios');
const Currency = require('../models/Currency');
const { previewCurrencyImpact, storeSuggestions } = require('./PriceCalculator');
const CacheService = require('./CacheService');

const SUPPORTED_CURRENCIES = ['BRL', 'PHP', 'USD'];
const EXCHANGE_API_BASE = 'https://open.er-api.com/v6/latest/MMK';

/**
 * Fetch live rates from external API and store suggestions (does NOT approve finalPrice).
 */
async function fetchLiveRates() {
  const { data } = await axios.get(EXCHANGE_API_BASE, { timeout: 8000 });
  if (data.result !== 'success') throw new Error('Exchange API returned failure status');

  const rates = data.rates;
  const updates = [];

  for (const code of SUPPORTED_CURRENCIES) {
    if (!rates[code]) continue;
    const rateToMMK = 1 / rates[code];
    await Currency.upsertRate(code, rateToMMK, 'api');
    updates.push({ code, rateToMMK: parseFloat(rateToMMK.toFixed(4)) });
  }

  CacheService.invalidateRates(); // bust the 15-min cache on live fetch
  console.log('[CurrencyService] Live rates updated:', updates);
  return updates;
}

/**
 * Admin-driven rate update.
 * Saves the new rate + computes + stores suggestions.
 * Returns preview data so the admin can approve or edit before committing finalPrice.
 *
 * @param {string} currencyCode
 * @param {number} newRate - rateToMMK (1 BRL = X MMK)
 * @param {string} source  - 'manual' | 'api'
 * @returns {{ rateDoc, previews: Array, affectedCount: number }}
 */
async function updateRate(currencyCode, newRate, source = 'manual') {
  const code = currencyCode.toUpperCase();

  const rateDoc = await Currency.upsertRate(code, newRate, source);

  const previews = await previewCurrencyImpact(code, newRate);
  await storeSuggestions(previews);

  CacheService.invalidateRates(); // bust cache whenever a rate changes
  console.log(`[CurrencyService] Rate updated: 1 ${code} = ${newRate} MMK | ${previews.length} products affected`);

  return { rateDoc, previews, affectedCount: previews.length };
}

/**
 * Get a single currency rate.
 */
async function getRate(code) {
  return Currency.getRate(code);
}

/**
 * Get all stored rates — served from 15-min in-memory cache.
 */
async function getAllRates() {
  return CacheService.getCachedRates();
}

/**
 * Manual set (backward compat alias).
 */
async function manualSetRate(currencyCode, rate) {
  return updateRate(currencyCode, rate, 'manual');
}

module.exports = {
  fetchLiveRates,
  updateRate,
  manualSetRate,
  getRate,
  getAllRates,
};
