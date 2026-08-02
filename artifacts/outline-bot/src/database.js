const mongoose = require('mongoose');
const { config } = require('./config');

async function connectDB() {
  await mongoose.connect(config.mongoUri, {
    dbName: 'outline_vpn_bot',
  });
  console.log('[DB] MongoDB connected');
}

module.exports = { connectDB };
