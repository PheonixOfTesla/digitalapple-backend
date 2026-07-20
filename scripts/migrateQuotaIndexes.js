/**
 * Migration: Fix UserQuota indexes
 *
 * Drops old unique indexes that don't have partial filters,
 * allowing the schema's partial filter indexes to take effect.
 */

const mongoose = require('mongoose');

async function migrate() {
  const collection = mongoose.connection.collection('userquotas');

  try {
    // Get existing indexes
    const indexes = await collection.indexes();
    console.log('[Migration] Current userquotas indexes:', indexes.map(i => i.name));

    // Drop problematic indexes (unique without partial filter)
    const toDrop = ['userId_1_date_1', 'anonymousSessionId_1_date_1'];

    for (const name of toDrop) {
      const exists = indexes.find(i => i.name === name);
      if (exists && !exists.partialFilterExpression) {
        console.log(`[Migration] Dropping old index: ${name}`);
        await collection.dropIndex(name);
        console.log(`[Migration] Dropped: ${name}`);
      }
    }

    console.log('[Migration] UserQuota index migration complete');
  } catch (err) {
    // Index might not exist, that's ok
    if (err.code === 27 || err.message.includes('not found')) {
      console.log('[Migration] Index not found, skipping');
    } else {
      console.error('[Migration] Error:', err.message);
    }
  }
}

module.exports = migrate;
