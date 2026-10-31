const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';

/**
 * Returns the 32-byte master encryption key buffer from hex config
 */
function getMasterKey() {
  const hex = config.encryptionSecretKey;
  if (!hex || hex.length !== 64) {
    // Fallback: derive a 32-byte key from whatever string was provided
    return crypto.createHash('sha256').update(hex || 'default-teledoc-key-salt').digest();
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a buffer with AES-256-GCM
 * @param {Buffer} buffer - Plaintext file buffer
 * @returns {{ encryptedBuffer: Buffer, iv: string, authTag: string }}
 */
function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);

  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedBuffer: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted buffer
 * @param {Buffer} encryptedBuffer - Ciphertext file buffer
 * @param {string} ivHex - Hex-encoded IV
 * @param {string} authTagHex - Hex-encoded GCM Auth Tag
 * @returns {Buffer} - Decrypted plaintext file buffer
 */
function decryptBuffer(encryptedBuffer, ivHex, authTagHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), iv);

  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

/**
 * Compute SHA-256 checksum for deduplication and integrity check
 * @param {Buffer} buffer
 * @returns {string} hex hash
 */
function computeChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  computeChecksum,
};

