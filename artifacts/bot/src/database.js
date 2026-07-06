const mongoose = require('mongoose');
const { config } = require('../config/settings');

let isConnected = false;

const MAX_RETRIES  = 5;
const RETRY_DELAY  = 5000;

async function connectDB(attempt = 1) {
  if (isConnected) {
    console.log('[DB] Already connected to MongoDB');
    return;
  }

  try {
    await mongoose.connect(config.db.uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
    });

    isConnected = true;
    console.log('[DB] ✅ Connected to MongoDB successfully');

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] MongoDB disconnected — retrying in 5s...');
      isConnected = false;
      setTimeout(() => connectDB(1), RETRY_DELAY);
    });

    mongoose.connection.on('error', (err) => {
      console.error('[DB] MongoDB connection error:', err.message);
    });

  } catch (err) {
    if (attempt < MAX_RETRIES) {
      console.error(`[DB] ❌ Connection failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      console.log(`[DB] Retrying in ${RETRY_DELAY / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
      return connectDB(attempt + 1);
    }

    console.error(`[DB] ❌ Could not connect after ${MAX_RETRIES} attempts.`);
    console.error('[DB] Common fixes:');
    console.error('[DB]   1. MongoDB Atlas → Network Access → Add IP → 0.0.0.0/0 (allow all)');
    console.error('[DB]   2. Check MONGODB_URI secret is correct');
    process.exit(1);
  }
}

async function disconnectDB() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  console.log('[DB] Disconnected from MongoDB');
}

module.exports = { connectDB, disconnectDB };
