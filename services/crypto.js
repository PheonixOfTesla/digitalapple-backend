/**
 * crypto — at-rest encryption for sensitive text (message bodies).
 *
 * AES-256-GCM. The key is derived (scrypt) from MESSAGE_ENC_KEY if set, else from
 * JWT_SECRET, so encryption works with no extra config. Ciphertext is stored as
 * "v1:<base64(iv|tag|cipher)>"; plaintext without that prefix decrypts to itself
 * (so legacy rows and a missing key never break reads).
 *
 * NOTE: this is encryption AT REST (server holds the key), not end-to-end. It
 * keeps message bodies unreadable in DB dumps/backups. True E2EE would require
 * client-managed keys — a larger, separate effort.
 */
const crypto = require('crypto');

const SECRET = process.env.MESSAGE_ENC_KEY || process.env.JWT_SECRET || 'clockwork-dev-fallback-key';
const KEY = crypto.scryptSync(String(SECRET), 'clockwork-msg-v1', 32);
const PREFIX = 'v1:';

function encryptText(plain) {
  if (plain == null || plain === '') return plain;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
  } catch (e) {
    return plain; // never lose the message over an encode error
  }
}

function decryptText(stored) {
  if (stored == null || typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { encryptText, decryptText };
