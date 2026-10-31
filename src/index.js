const express = require('express');
const cors = require('cors');
const config = require('./config');
const documentRoutes = require('./routes/documentRoutes');
const indexManager = require('./utils/indexManager');
const telegramService = require('./services/telegramService');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api', documentRoutes);

// Root health ping
app.get('/', (req, res) => {
  res.json({
    app: 'TeleDoc Hub API',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[TeleDoc Server Error]:', err.stack || err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Server boot
const server = app.listen(config.port, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 TeleDoc Hub Server running on http://localhost:${config.port}`);
  console.log(`   Telegram Bot API base: ${config.telegramApiBase.replace(/:[^:]+@/, ':***@')}`);
  console.log(`   Target Channel ID:    ${config.telegramChatId}`);
  console.log(`======================================================\n`);

  try {
    const tgCheck = await telegramService.testConnection();
    if (tgCheck.connected) {
      console.log(`✅ [Telegram Vault] Connected to channel: "${tgCheck.channel}" via bot @${tgCheck.bot}`);
    } else {
      console.error(`❌ [Telegram Vault] Connection Failed: ${tgCheck.error} (Chat ID: ${config.telegramChatId || 'NOT SET'})`);
    }
  } catch (tgErr) {
    console.error(`❌ [Telegram Vault] Check error:`, tgErr.message);
  }

  try {
    await indexManager.init();
  } catch (err) {
    console.error('[TeleDoc Hub] Boot initialization warning:', err.message);
  }
});

module.exports = { app, server };

