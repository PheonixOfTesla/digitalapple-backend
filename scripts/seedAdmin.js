/**
 * Seed admin user: digitalappleco@gmail.com
 *
 * Usage:
 *   ADMIN_PASSWORD=your-secure-password node scripts/seedAdmin.js
 *
 * Or set ADMIN_SEED_PASSWORD in Railway env vars and run:
 *   node scripts/seedAdmin.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = 'digitalappleco@gmail.com';

async function seedAdmin() {
  const password = process.env.ADMIN_PASSWORD || process.env.ADMIN_SEED_PASSWORD;

  if (!password) {
    console.error('Error: No password provided');
    console.error('Set ADMIN_PASSWORD or ADMIN_SEED_PASSWORD environment variable');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const User = require('../models/User');

    // Check if admin exists
    const existing = await User.findOne({ email: ADMIN_EMAIL });

    if (existing) {
      console.log(`Admin ${ADMIN_EMAIL} already exists`);

      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
        console.log('Updated role to admin');
      }

      // Update password if requested
      if (process.env.UPDATE_PASSWORD === 'true') {
        existing.passwordHash = await bcrypt.hash(password, 10);
        await existing.save();
        console.log('Password updated');
      }
    } else {
      const passwordHash = await bcrypt.hash(password, 10);

      const admin = new User({
        email: ADMIN_EMAIL,
        passwordHash,
        role: 'admin',
        emailVerified: true,
        firstName: 'DigitalApple',
        lastName: 'Admin'
      });

      await admin.save();
      console.log(`Admin created: ${ADMIN_EMAIL}`);
    }

    console.log('Done');
    process.exit(0);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

seedAdmin();
