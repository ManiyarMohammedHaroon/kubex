/**
 * @file db.js — MongoDB connection setup.
 *
 * Exports a single async function `connectDB` that establishes the Mongoose
 * connection using the MONGO_URI environment variable.
 *
 * Called once during server bootstrap (see index.js).
 * If the connection fails the process exits with code 1 so that Docker / PM2
 * can restart the container rather than running in a broken state.
 */
const mongoose = require('mongoose');

/**
 * Connect to MongoDB using Mongoose.
 * Reads MONGO_URI from the environment.
 * On success, logs the host name.
 * On failure, logs the error and exits the process.
 */
const connectDB = async () => {
  mongoose.set('bufferCommands', false);
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        family: 4 // Force IPv4
    });
    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`[DB] Connection error: ${err.message}`);
    process.exit(1); // Hard exit — no point running without a database
  }
};

module.exports = connectDB;
