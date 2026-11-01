const express = require('express');
const cors = require('cors');
const config = require('./config');
const documentRoutes = require('./routes/documentRoutes');
const indexManager = require('./utils/indexManager');
const telegramService = require('./services/telegramService');

const app = express();

// Middlewares
// 1. High-priority CORS & Preflight Response Interceptor
// Runs before all routes, body parsers, and error handlers to guarantee CORS headers on every response
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    const requestedHeaders = req.headers['access-control-request-headers'];
    if (requestedHeaders) {
      res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
    } else {
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-Requested-With,Accept,Origin,Range,X-File-Name'
      );
    }
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range,Accept-Ranges,Content-Length,Content-Disposition,ETag'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  // Immediately terminate preflight OPTIONS requests with 204 No Content
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// 2. Standard CORS middleware (defaults to auto-reflecting requested headers when allowedHeaders is omitted)
const corsOptions = {
  origin: true, // Echoes the requesting origin (Vercel, localhost, custom domains)
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  exposedHeaders: [
    'Content-Range',
    'Accept-Ranges',
    'Content-Length',
    'Content-Disposition',
    'ETag',
  ],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 3. Body parsers
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

// Error handling middleware (preserves CORS headers on all errors)
app.use((err, req, res, next) => {
  console.error('[TeleDoc Server Error]:', err.stack || err.message);
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
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

