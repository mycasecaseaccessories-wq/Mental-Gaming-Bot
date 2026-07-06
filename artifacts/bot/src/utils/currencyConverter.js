const Currency = require('../models/Currency');

async function toMMK(amount, fromCurrency) {
  const rate = await Currency.getRate(fromCurrency);
  if (!rate) throw new Error(`Exchange rate for ${fromCurrency} not found`);
  return Math.round(amount * rate);
}

async function fromMMK(amountMMK, toCurrency) {
  const rate = await Currency.getRate(toCurrency);
  if (!rate) throw new Error(`Exchange rate for ${toCurrency} not found`);
  return parseFloat((amountMMK / rate).toFixed(2));
}

function formatMMK(amount) {
  return `${Number(amount).toLocaleString()} KS`;
}

function formatCurrency(amount, code) {
  return `${Number(amount).toLocaleString()} ${code.toUpperCase()}`;
}

module.exports = { toMMK, fromMMK, formatMMK, formatCurrency };
