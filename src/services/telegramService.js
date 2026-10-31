const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const config = require('../config');

class TelegramService {
  constructor() {
    this.apiBase = config.telegramApiBase;
    this.fileBase = config.telegramFileBase;
    this.chatId = config.telegramChatId;
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });
    this.fileCache = new Map(); // fileId -> { buffer, timestamp }
    this.pathCache = new Map(); // fileId -> { filePath, timestamp }
    this.maxCacheEntries = 20;
    this.cacheTtlMs = 15 * 60 * 1000; // 15 minutes ephemeral cache
  }

  /**
   * Upload buffer directly to Telegram private channel
   * @param {Buffer} buffer
   * @param {string} filename
   * @param {string} caption
   */
  async uploadDocument(buffer, filename, caption = '') {
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const form = new FormData();
        form.append('chat_id', this.chatId);
        form.append('document', buffer, { filename });
        if (caption) {
          form.append('caption', caption.substring(0, 1024));
        }

        const formLength = form.getLengthSync ? form.getLengthSync() : undefined;
        const headers = form.getHeaders();
        if (formLength) {
          headers['Content-Length'] = formLength;
        }

        const response = await axios.post(`${this.apiBase}/sendDocument`, form, {
          headers,
          httpsAgent: this.httpsAgent,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 180000, // 3 minutes timeout (plenty of headroom for 20MB videos)
        });

        if (!response.data || !response.data.ok) {
          throw new Error(response.data?.description || 'Failed to upload document to Telegram');
        }

        const result = response.data.result;
        const doc = result.document;

        return {
          messageId: result.message_id,
          fileId: doc.file_id,
          fileName: doc.file_name,
          fileSize: doc.file_size,
          mimeType: doc.mime_type,
        };
      } catch (err) {
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const errDetail = err.response?.data?.description || err.message;

        // Auto-heal if configured chat ID in deployment was mistyped or outdated
        if (errDetail?.includes('chat not found') && this.chatId !== '-1003747303892') {
          console.warn(`[Telegram Vault Recovery] Upload hit "chat not found" with ${this.chatId}. Auto-switching to verified vault channel -1003747303892.`);
          this.chatId = '-1003747303892';
          continue;
        }

        if (attempts >= maxAttempts) {
          console.error('Telegram uploadDocument error:', errDetail);
          throw new Error(`Telegram Upload Error: ${errDetail}`);
        }
        console.warn(`Telegram upload attempt ${attempts} failed (${err.message}). Retrying in 1.5s...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  /**
   * Download a file from Telegram using its file_id (with in-memory LRU cache)
   * @param {string} fileId
   * @returns {Promise<Buffer>}
   */
  async downloadFile(fileId) {
    // 0. Fast-path: Check ephemeral in-memory cache for instant seeking/streaming
    const cached = this.fileCache.get(fileId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.buffer;
    }

    try {
      // 1. Fast-path: Check cached file_path to save 200-400ms Telegram getFile roundtrip
      let filePath = null;
      const cachedPath = this.pathCache.get(fileId);
      if (cachedPath && Date.now() - cachedPath.timestamp < this.cacheTtlMs * 4) {
        filePath = cachedPath.filePath;
      } else {
        const pathRes = await axios.get(`${this.apiBase}/getFile`, {
          params: { file_id: fileId },
          httpsAgent: this.httpsAgent,
          timeout: 15000,
        });

        if (!pathRes.data || !pathRes.data.ok) {
          throw new Error(pathRes.data?.description || 'Could not locate file path on Telegram');
        }

        filePath = pathRes.data.result.file_path;
        this.pathCache.set(fileId, { filePath, timestamp: Date.now() });
      }

      // 2. Download the binary stream with connection pooling
      const fileRes = await axios.get(`${this.fileBase}/${filePath}`, {
        responseType: 'arraybuffer',
        httpsAgent: this.httpsAgent,
        timeout: 120000, // 2 minutes timeout for streaming
      });

      const buffer = Buffer.from(fileRes.data);

      // 3. Cache buffer in memory for instant subsequent chunk/range requests
      if (this.fileCache.size >= this.maxCacheEntries) {
        const oldestKey = this.fileCache.keys().next().value;
        this.fileCache.delete(oldestKey);
      }
      this.fileCache.set(fileId, { buffer, timestamp: Date.now() });

      return buffer;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      console.error('Telegram downloadFile error:', errDetail);
      throw new Error(`Telegram Download Error: ${errDetail}`);
    }
  }

  /**
   * Delete a message from the Telegram channel
   * @param {number} messageId
   */
  async deleteMessage(messageId) {
    try {
      const response = await axios.post(`${this.apiBase}/deleteMessage`, {
        chat_id: this.chatId,
        message_id: messageId
      });
      return response.data?.ok || false;
    } catch (err) {
      console.warn(`Telegram deleteMessage (${messageId}) warning:`, err.response?.data?.description || err.message);
      return false;
    }
  }

  /**
   * Pin a message in the Telegram channel
   * @param {number} messageId
   */
  async pinMessage(messageId) {
    try {
      const response = await axios.post(`${this.apiBase}/pinChatMessage`, {
        chat_id: this.chatId,
        message_id: messageId,
        disable_notification: true
      });
      return response.data?.ok || false;
    } catch (err) {
      console.warn(`Telegram pinMessage (${messageId}) warning:`, err.response?.data?.description || err.message);
      return false;
    }
  }

  /**
   * Update media of an existing message (used for updating pinned index.json)
   * @param {number} messageId
   * @param {Buffer} buffer
   * @param {string} filename
   */
  async updateMessageDocument(messageId, buffer, filename) {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('message_id', messageId);
    form.append(
      'media',
      JSON.stringify({
        type: 'document',
        media: 'attach://file',
        caption: `TeleDoc Master Index [Updated: ${new Date().toISOString()}]`
      })
    );
    form.append('file', buffer, { filename });

    try {
      const response = await axios.post(`${this.apiBase}/editMessageMedia`, form, {
        headers: form.getHeaders(),
        timeout: 20000
      });
      return response.data?.ok || false;
    } catch (err) {
      console.warn('Telegram updateMessageDocument fallback needed:', err.response?.data?.description || err.message);
      return false;
    }
  }

  /**
   * Check connection status
   */
  async testConnection() {
    let botUsername = null;
    try {
      const me = await axios.get(`${this.apiBase}/getMe`, { timeout: 5000 });
      botUsername = me.data.result?.username;

      let chat = null;
      try {
        chat = await axios.get(`${this.apiBase}/getChat`, {
          params: { chat_id: this.chatId },
          timeout: 5000
        });
      } catch (chatErr) {
        const fallbackChannel = '-1003747303892';
        if (this.chatId !== fallbackChannel) {
          try {
            const fallbackChat = await axios.get(`${this.apiBase}/getChat`, {
              params: { chat_id: fallbackChannel },
              timeout: 5000
            });
            if (fallbackChat.data?.ok) {
              console.warn(`[Telegram Vault Recovery] Configured chatId (${this.chatId}) failed with "${chatErr.response?.data?.description || chatErr.message}". Auto-recovered to verified channel ${fallbackChannel}.`);
              this.chatId = fallbackChannel;
              chat = fallbackChat;
            }
          } catch {
            throw chatErr;
          }
        } else {
          throw chatErr;
        }
      }

      return {
        connected: true,
        bot: botUsername,
        channel: chat.data.result?.title,
        chatId: this.chatId
      };
    } catch (err) {
      return {
        connected: false,
        bot: botUsername || 'unreachable',
        configuredChatId: this.chatId || 'not_set',
        error: err.response?.data?.description || err.message,
        tip: 'Ensure the Telegram bot is added as an Administrator to your channel with Post Messages permission, and TELEGRAM_CHAT_ID is set to -1003747303892 without quotes in Render.'
      };
    }
  }
}

module.exports = new TelegramService();

