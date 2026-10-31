const mongoose = require('mongoose');
const config = require('../config');

let isConnected = false;

async function connectDB() {
  if (isConnected) {
    return mongoose.connection;
  }

  try {
    const conn = await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    console.log(`[MongoDB] Connected to database: ${conn.connection.name} @ ${conn.connection.host}:${conn.connection.port}`);

    mongoose.connection.on('error', (err) => {
      console.error('[MongoDB] Connection error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[MongoDB] Disconnected from database.');
      isConnected = false;
    });

    return mongoose.connection;
  } catch (err) {
    console.error('[MongoDB] Failed to connect to MongoDB:', err.message);
    console.warn('[MongoDB] Please ensure MongoDB service is active. Falling back to in-memory mode if unavailable.');
    throw err;
  }
}

module.exports = {
  connectDB,
  getConnection: () => mongoose.connection,
};

