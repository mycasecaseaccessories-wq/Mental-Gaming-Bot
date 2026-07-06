/**
 * AddressBookService
 *
 * Manages saved Game IDs per user.
 * Used in the order flow to let users pick saved accounts.
 */

const AddressBook = require('../models/AddressBook');
const User = require('../models/User');

async function getEntries(telegramId, gameName = null) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return [];
  return AddressBook.getForUser(user._id, gameName);
}

async function saveEntry(telegramId, { gameName, gameId, zoneId = null, nickname = null, setDefault = false }) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const MAX_PER_GAME = 5;
  const existing = await AddressBook.find({ userId: user._id, gameName });
  if (existing.length >= MAX_PER_GAME) {
    throw new Error(`You can save up to ${MAX_PER_GAME} IDs per game. Delete one first.`);
  }

  if (setDefault) {
    await AddressBook.updateMany({ userId: user._id, gameName }, { isDefault: false });
  }

  const entry = await AddressBook.create({
    userId: user._id,
    gameName,
    gameId,
    zoneId,
    nickname: nickname || gameId,
    isDefault: setDefault || existing.length === 0,
  });

  return entry;
}

async function deleteEntry(telegramId, entryId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const entry = await AddressBook.findOneAndDelete({ _id: entryId, userId: user._id });
  if (!entry) throw new Error('Entry not found or access denied');
  return entry;
}

async function setDefault(telegramId, entryId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');
  return AddressBook.setDefault(entryId, user._id);
}

function formatEntry(entry) {
  const zone = entry.zoneId ? ` (Zone: ${entry.zoneId})` : '';
  const label = entry.nickname && entry.nickname !== entry.gameId ? `${entry.nickname} — ` : '';
  return `${label}ID: ${entry.gameId}${zone}`;
}

module.exports = { getEntries, saveEntry, deleteEntry, setDefault, formatEntry };
