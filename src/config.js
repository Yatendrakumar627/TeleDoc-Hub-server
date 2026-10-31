const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Safe ephemeral fallbacks generated at runtime if environment variables are missing
const ephemeralEncryptionKey = () => {
  console.warn('[SECURITY WARNING] ENCRYPTION_SECRET_KEY not set in .env! Using generated ephemeral key for this session.');
  return crypto.randomBytes(32).toString('hex');
};

const ephemeralJwtSecret = () => {
  console.warn('[SECURITY WARNING] JWT_SECRET not set in .env! Using generated ephemeral secret for this session.');
  return crypto.randomBytes(32).toString('hex');
};

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  indexMessageId: process.env.INDEX_MESSAGE_ID || null,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/teledoc_hub',
  encryptionSecretKey: process.env.ENCRYPTION_SECRET_KEY || ephemeralEncryptionKey(),
  jwtSecret: process.env.JWT_SECRET || ephemeralJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB Ingestion Limit (Smart Compressed to < 19.5 MB for Telegram)
  telegramApiBase: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || ''}`,
  telegramFileBase: `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN || ''}`
};

module.exports = config;
