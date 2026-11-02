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

const cleanString = (val) => (val ? String(val).trim().replace(/^["']|["']$/g, '').trim() : '');

const botToken = cleanString(process.env.TELEGRAM_BOT_TOKEN);
let chatId = cleanString(process.env.TELEGRAM_CHAT_ID);

if (!botToken) {
  console.warn('[SECURITY WARNING] TELEGRAM_BOT_TOKEN is not defined in environment variables! Please set it in .env or your hosting dashboard.');
}

// Auto-normalize channel IDs if quotes or missing -100 prefix occurred
if (chatId && !chatId.startsWith('@')) {
  // If user entered -3747303892 instead of -1003747303892
  if (chatId.startsWith('-') && !chatId.startsWith('-100') && chatId.length >= 10) {
    chatId = `-100${chatId.slice(1)}`;
  } else if (!chatId.startsWith('-') && /^\d{10,}$/.test(chatId)) {
    // If user pasted 3747303892 without -100
    chatId = `-100${chatId}`;
  }
}

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  telegramBotToken: botToken,
  telegramChatId: chatId,
  indexMessageId: cleanString(process.env.INDEX_MESSAGE_ID) || null,
  mongoUri: cleanString(process.env.MONGODB_URI) || 'mongodb://127.0.0.1:27017/teledoc_hub',
  encryptionSecretKey: cleanString(process.env.ENCRYPTION_SECRET_KEY) || ephemeralEncryptionKey(),
  jwtSecret: cleanString(process.env.JWT_SECRET) || ephemeralJwtSecret(),
  jwtExpiresIn: cleanString(process.env.JWT_EXPIRES_IN) || '7d',
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB Ingestion Limit (Smart Compressed to < 19.5 MB for Telegram)
  telegramApiBase: `https://api.telegram.org/bot${botToken}`,
  telegramFileBase: `https://api.telegram.org/file/bot${botToken}`
};

module.exports = config;
