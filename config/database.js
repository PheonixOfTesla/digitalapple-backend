const mongoose = require('mongoose');
const migrateQuotaIndexes = require('../scripts/migrateQuotaIndexes');

async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB connected: ${conn.connection.host}`);

    // Run migrations after connection
    await migrateQuotaIndexes();
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

module.exports = { connectDB };
