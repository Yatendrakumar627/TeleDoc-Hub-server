const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');

const SALT_ROUNDS = 10;

/**
 * Hash a plain text password with bcrypt
 */
async function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string') {
    throw new Error('Password must be a valid non-empty string.');
  }
  return await bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compare plain password against bcrypt hash
 */
async function comparePassword(plainPassword, hash) {
  if (!plainPassword || !hash) return false;
  return await bcrypt.compare(plainPassword, hash);
}

/**
 * Generate a signed JWT for a user
 */
function generateToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    name: user.name || '',
    role: user.role || 'user',
  };

  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Verify and decode a JWT
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return null;
  }
}

/**
 * Generate unique random 32-byte salt for user vault
 */
function generateVaultSalt() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  generateVaultSalt,
};

