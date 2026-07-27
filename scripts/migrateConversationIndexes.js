/**
 * Migration: Fix Conversation indexes.
 *
 * The original participantKey / sourceKey unique indexes were created WITHOUT a
 * sparse/partial filter. That means every room (participantKey null) and every
 * non-source conversation (sourceKey null) collides on the null key — so only the
 * first room could ever be inserted. Dropping the non-partial unique indexes lets
 * the schema's `unique + sparse` indexes recreate correctly, so many rooms/studios
 * can coexist while true 1:1 DMs still dedupe by participantKey.
 */
const mongoose = require('mongoose');

async function migrate() {
  const collection = mongoose.connection.collection('conversations');
  try {
    const indexes = await collection.indexes();
    console.log('[Migration] Current conversations indexes:', indexes.map(i => i.name));

    for (const spec of [{ name: 'participantKey_1', key: 'participantKey' }, { name: 'sourceKey_1', key: 'sourceKey' }]) {
      const existing = indexes.find(i => i.name === spec.name);
      // Drop only if it exists and is NOT sparse and has NO partial filter.
      if (existing && !existing.sparse && !existing.partialFilterExpression) {
        console.log(`[Migration] Dropping non-sparse index: ${spec.name}`);
        await collection.dropIndex(spec.name);
        console.log(`[Migration] Dropped: ${spec.name}`);
      }
      // Ensure the correct unique + sparse index exists (idempotent).
      const fresh = (await collection.indexes()).find(i => i.name === spec.name);
      if (!fresh) {
        await collection.createIndex({ [spec.key]: 1 }, { unique: true, sparse: true, name: spec.name });
        console.log(`[Migration] Recreated ${spec.name} as unique + sparse`);
      }
    }
    console.log('[Migration] Conversation index migration complete');
  } catch (err) {
    if (err.code === 27 || (err.message || '').includes('not found')) {
      console.log('[Migration] Conversation index not found, skipping');
    } else {
      console.error('[Migration] Conversation index error:', err.message);
    }
  }
}

module.exports = migrate;
