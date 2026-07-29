/**
 * Upgrade existing profile photo thumbnails: w_100 → w_320, retina-ready.
 *
 * The thumb is a Cloudinary on-the-fly transformation of the stored master,
 * so rewriting the stored URL is enough — no re-upload needed. New uploads
 * already mint 320px thumbs (UserController).
 *
 * Usage: node scripts/upgradeAvatarThumbs.js   (needs MONGODB_URI)
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
  const User = require('../models/User');

  const r = await User.updateMany(
    { profilePhotoThumb: { $regex: 'w_100,h_100,c_fill,g_face' } },
    [{
      $set: {
        profilePhotoThumb: {
          $replaceOne: {
            input: '$profilePhotoThumb',
            find: 'w_100,h_100,c_fill,g_face',
            replacement: 'w_320,h_320,c_fill,g_face,q_auto'
          }
        }
      }
    }]
  );
  console.log(`Upgraded ${r.modifiedCount} thumbnail URLs`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
