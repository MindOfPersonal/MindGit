'use strict';

/**
 * Veilige encryptie/decryptie voor gevoelige waarden (zoals het GitHub token).
 * Gebruikt AES-256-GCM met een willekeurige IV per encryptie.
 *
 * Vereist TOKEN_ENCRYPTION_KEY in .env. Genereer een key met:
 *   node scripts/generate-key.js
 */

const crypto = require('crypto');

const ENCRYPTION_PREFIX = 'enc:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is niet ingesteld in .env. ' +
      'Genereer een key met: node scripts/generate-key.js'
    );
  }

  let key;
  if (raw.length === 64 && /^[0-9a-f]+$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (raw.length === 44 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
    key = Buffer.from(raw, 'base64');
  } else if (Buffer.byteLength(raw) === 32) {
    key = Buffer.from(raw, 'utf-8');
  } else {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY moet een 32-byte key zijn (base64, hex of exact 32 tekens). ' +
      'Genereer een key met: node scripts/generate-key.js'
    );
  }

  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY moet 32 bytes zijn, nu ${key.length} bytes.`);
  }
  return key;
}

/**
 * Versleutel een plaintext string. Als de waarde al versleuteld is, wordt deze ongewijzigd teruggegeven.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  if (String(plaintext).startsWith(ENCRYPTION_PREFIX)) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const result = Buffer.concat([iv, tag, encrypted]).toString('base64');
  return ENCRYPTION_PREFIX + result;
}

/**
 * Ontsleutel een ciphertext string. Legacy plaintext tokens worden transparant ondersteund.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!String(ciphertext).startsWith(ENCRYPTION_PREFIX)) {
    return ciphertext; // legacy plaintext
  }

  const data = Buffer.from(String(ciphertext).slice(ENCRYPTION_PREFIX.length), 'base64');
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Ongeldige encrypted token (te kort).');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isEncrypted(ciphertext) {
  return String(ciphertext).startsWith(ENCRYPTION_PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
