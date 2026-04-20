/**
 * AES-256-GCM Encryption Service
 *
 * Replaces insecure CryptoJS ECB-mode encryption with Node.js native
 * crypto using AES-256-GCM (authenticated encryption).
 *
 * Format: v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Backward-compatible: decrypt() auto-detects legacy CryptoJS format
 * and decrypts it, so existing encrypted data keeps working.
 */

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const VERSION_PREFIX = 'v1:';

/**
 * Derive a consistent 32-byte key from the config encryption key.
 * Uses SHA-256 to normalize any-length passphrase into a 256-bit key.
 */
const deriveKey = () => {
  const raw = config.encryptionKey;
  if (!raw) throw new Error('ENCRYPTION_KEY not set');
  return crypto.createHash('sha256').update(String(raw)).digest();
};

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns: v1:<iv>:<authTag>:<ciphertext>  (all hex-encoded)
 */
const encrypt = (text) => {
  if (!text) return text;
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${VERSION_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
};

/**
 * Decrypt ciphertext. Auto-detects format:
 * - v1: prefix → AES-256-GCM (new format)
 * - Otherwise → legacy CryptoJS AES (backward compat)
 */
const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext;

  // ── New GCM format ────────────────────────────────────────
  if (String(ciphertext).startsWith(VERSION_PREFIX)) {
    const parts = String(ciphertext).slice(VERSION_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Malformed GCM ciphertext');

    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = deriveKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── Legacy CryptoJS fallback (backward compat) ────────────
  try {
    const CryptoJS = require('crypto-js');
    const bytes = CryptoJS.AES.decrypt(ciphertext, config.encryptionKey);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    if (!result) throw new Error('Empty decryption result');
    return result;
  } catch (legacyErr) {
    throw new Error(`Decryption failed: ${legacyErr.message}`);
  }
};

/**
 * Re-encrypt a value from legacy format to GCM.
 * Returns null if already in GCM format or if decryption fails.
 */
const migrateToGCM = (ciphertext) => {
  if (!ciphertext || String(ciphertext).startsWith(VERSION_PREFIX)) return null;
  try {
    const plaintext = decrypt(ciphertext);
    return encrypt(plaintext);
  } catch {
    return null;
  }
};

module.exports = { encrypt, decrypt, migrateToGCM };
