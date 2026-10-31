const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const uuidv4 = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
const config = require('../config');
const telegramService = require('../services/telegramService');
const parserService = require('../services/parserService');
const googleLinkService = require('../services/googleLinkService');
const mediaOptimizer = require('../services/mediaOptimizer');
const indexManager = require('../utils/indexManager');
const { encryptBuffer, decryptBuffer, computeChecksum } = require('../utils/cryptoUtil');
const { classifyDocument } = require('../utils/classifier');
const { requireAuth, optionalAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Memory-only storage for stateless ephemeral runtime - ACCEPTS ALL FILE TYPES
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSizeBytes, // 20 MB ceiling
  },
  // No fileFilter: Allow any file type (images, videos, audio, pdf, docs, code, zip, binaries)
});

// High-Performance Ephemeral Decrypted Media Buffer Cache (Eliminates repeated AES-256 decryption across video range seeks)
const decryptedMediaCache = new Map(); // docId -> { buffer, timestamp }
const MEDIA_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL
const MAX_MEDIA_CACHE_ITEMS = 25;

function getCachedDecryptedBuffer(id) {
  const cached = decryptedMediaCache.get(id);
  if (cached && Date.now() - cached.timestamp < MEDIA_CACHE_TTL_MS) {
    return cached.buffer;
  }
  return null;
}

function setCachedDecryptedBuffer(id, buffer) {
  if (decryptedMediaCache.size >= MAX_MEDIA_CACHE_ITEMS) {
    const oldestKey = decryptedMediaCache.keys().next().value;
    decryptedMediaCache.delete(oldestKey);
  }
  decryptedMediaCache.set(id, { buffer, timestamp: Date.now() });
}

/**
 * GET /api/status - Health, Telegram status, and MongoDB state (Public / Optional Auth)
 */
router.get('/status', optionalAuth, async (req, res) => {
  try {
    const tgStatus = await telegramService.testConnection();
    const userId = req.user ? req.user.id : null;
    const allDocs = await indexManager.getAllDocuments({}, userId);
    const allCollections = await indexManager.getAllCollections('all', userId);

    // Group counts
    const personalCount = allDocs.filter((d) => d.scope === 'personal').length;
    const professionalCount = allDocs.filter((d) => d.scope === 'professional').length;
    const confidentialCount = allDocs.filter(
      (d) => d.security?.level === 'confidential' || d.security?.level === 'strictly_confidential'
    ).length;

    res.json({
      status: 'online',
      version: '2.2.0 (Zero-Knowledge Multi-Tenant Vault + Dedicated Auth)',
      authenticated: !!req.user,
      user: req.user || null,
      database: {
        type: 'MongoDB',
        connected: indexManager.isMongoConnected,
      },
      telegram: tgStatus,
      documentCount: allDocs.length,
      collectionCount: allCollections.length,
      metrics: {
        personal: personalCount,
        professional: professionalCount,
        confidential: confidentialCount,
      },
      maxFileSizeBytes: config.maxFileSizeBytes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== REQUIRE AUTHENTICATION FOR ALL VAULT OPERATIONS =====================
router.use(requireAuth);

/**
 * GET /api/documents - List documents with multi-dimensional filtering
 */
router.get('/documents', async (req, res) => {
  try {
    const filters = {
      scope: req.query.scope || 'all',
      collectionId: req.query.collectionId,
      group: req.query.group,
      subGroup: req.query.subGroup,
      securityLevel: req.query.securityLevel,
      year: req.query.year,
      month: req.query.month,
      tag: req.query.tag,
      search: req.query.search,
    };

    const documents = await indexManager.getAllDocuments(filters, req.user.id);
    res.json({ documents, total: documents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== GROUPS API (FILE & COLLECTION TAXONOMY) =====================

/**
 * GET /api/groups - List all user groups with collection and file counts
 */
router.get('/groups', async (req, res) => {
  try {
    const scope = req.query.scope || 'all';
    const groups = await indexManager.getAllGroups(scope, req.user.id);
    res.json({ groups, total: groups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups - Create a new user group
 */
router.post('/groups', async (req, res) => {
  try {
    const { name, description, color, icon, scope } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required.' });
    }

    const group = await indexManager.createGroup(
      {
        name: name.trim(),
        description: description || '',
        color: color || '#6366f1',
        icon: icon || 'FolderKanban',
        scope: scope || 'all',
      },
      req.user.id
    );

    res.status(201).json({ success: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/groups/:id - Get single group with member collections and files
 */
router.get('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const group = await indexManager.getGroupById(id, req.user.id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }
    res.json({ success: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/groups/:id - Update group metadata and cascade renames
 */
router.patch('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updated = await indexManager.updateGroup(id, updates, req.user.id);
    if (!updated) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    res.json({
      success: true,
      message: 'Group updated successfully.',
      group: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/groups/:id - Delete group (safe unassign vs cascade)
 */
router.delete('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cascade = req.query.cascade === 'true';

    const deleted = await indexManager.deleteGroup(id, { cascade }, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    res.json({
      success: true,
      message: cascade
        ? 'Group and all associated collections & files permanently deleted.'
        : 'Group disbanded. Associated collections and files preserved in General group.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/groups/assign - Assign either a collection or file to a group
 */
router.post('/groups/assign', async (req, res) => {
  try {
    const { targetType, targetId, groupId, groupName } = req.body;
    if (!targetType || !targetId) {
      return res.status(400).json({ error: 'targetType and targetId are required.' });
    }

    const updated = await indexManager.assignToGroup(
      { targetType, targetId, groupId, groupName },
      req.user.id
    );

    res.json({
      success: true,
      message: `Assigned ${targetType} to group ${groupName || 'General'}.`,
      item: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/groups/batch-assign - Batch assign collections or files to a group
 */
router.post('/groups/batch-assign', async (req, res) => {
  try {
    const { targetType, targetIds, groupId, groupName } = req.body;
    if (!targetType || !Array.isArray(targetIds) || targetIds.length === 0) {
      return res.status(400).json({ error: 'targetType and non-empty targetIds array are required.' });
    }

    const result = await indexManager.batchAssignToGroup(
      { targetType, targetIds, groupId, groupName },
      req.user.id
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
      message: `Assigned ${result.modifiedCount} ${targetType}(s) to group ${result.groupName || 'General'}.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /api/collections/:id/group & POST /api/collections/:id/group - Assign collection to group
 */
const handleAssignCollectionGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { groupId, groupName } = req.body;

    const updated = await indexManager.assignToGroup(
      { targetType: 'collection', targetId: id, groupId, groupName },
      req.user.id
    );

    res.json({
      success: true,
      message: `Collection moved to group ${updated.groupName}.`,
      collection: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

router.patch('/collections/:id/group', handleAssignCollectionGroup);
router.post('/collections/:id/group', handleAssignCollectionGroup);

/**
 * PATCH /api/documents/:id/group & POST /api/documents/:id/group - Assign document to group
 */
const handleAssignDocumentGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { groupId, groupName } = req.body;

    const updated = await indexManager.assignToGroup(
      { targetType: 'document', targetId: id, groupId, groupName },
      req.user.id
    );

    res.json({
      success: true,
      message: `Document moved to group ${updated.taxonomy?.group}.`,
      document: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

router.patch('/documents/:id/group', handleAssignDocumentGroup);
router.post('/documents/:id/group', handleAssignDocumentGroup);

// ===================== COLLECTIONS API =====================

/**
 * GET /api/collections - List user collections with document counts
 */
router.get('/collections', async (req, res) => {
  try {
    const scope = req.query.scope || 'all';
    const collections = await indexManager.getAllCollections(scope, req.user.id);
    res.json({ collections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/collections - Create a new custom collection
 */
router.post('/collections', async (req, res) => {
  try {
    const { name, scope, color, description, securityLevel, groupId, groupName } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Collection name is required.' });
    }

    const collection = await indexManager.createCollection(
      {
        name: name.trim(),
        scope: scope || 'professional',
        color: color || '#0284c7',
        description: description || '',
        securityLevel: securityLevel || 'confidential',
        groupId: groupId || null,
        groupName: groupName || 'General',
      },
      req.user.id
    );

    res.status(201).json({ success: true, collection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/collections/:id - Get collection details & files
 */
router.get('/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const collection = await indexManager.getCollectionById(id);
    if (!collection) {
      return res.status(404).json({ error: 'Collection not found.' });
    }
    res.json({ success: true, collection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/collections/:id - Update collection metadata & sync documents
 */
router.patch('/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updated = await indexManager.updateCollection(id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Collection not found.' });
    }

    res.json({
      success: true,
      message: 'Collection updated successfully.',
      collection: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/collections/:id - Delete collection
 * Query param: ?cascade=true (deletes files from storage) or default false (moves files to Inbox)
 */
router.delete('/collections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cascade = req.query.cascade === 'true';

    const deleted = await indexManager.deleteCollection(id, { cascade });
    if (!deleted) {
      return res.status(404).json({ error: 'Collection not found.' });
    }

    res.json({
      success: true,
      message: cascade
        ? 'Collection and all associated files deleted.'
        : 'Collection deleted. Files moved to Inbox (Unassigned).',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/documents/:id/collection & POST /api/documents/:id/move - Move document to a collection
 */
const handleMoveDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { collectionId, collectionName } = req.body;

    const updated = await indexManager.assignDocumentCollection(id, collectionId, collectionName);
    if (!updated) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    res.json({
      success: true,
      message: `Document moved to ${updated.collectionName}.`,
      document: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

router.patch('/documents/:id/collection', handleMoveDocument);
router.post('/documents/:id/move', handleMoveDocument);

/**
 * POST /api/documents/batch-move - Move multiple documents to a collection
 */
router.post('/documents/batch-move', async (req, res) => {
  try {
    const { documentIds, collectionId } = req.body;
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return res.status(400).json({ error: 'documentIds array is required.' });
    }

    const result = await indexManager.batchMoveDocuments(documentIds, collectionId);
    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
      collectionName: result.collectionName,
      message: `Moved ${result.modifiedCount} file(s) to ${result.collectionName}.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /api/documents/:id - General update of document metadata
 */
router.patch('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updated = await indexManager.updateDocument(id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    res.json({ success: true, document: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== ANALYTICS =====================

/**
 * GET /api/analytics/timeline - Aggregated time-wise breakdown
 */
router.get('/analytics/timeline', async (req, res) => {
  try {
    const scope = req.query.scope || 'all';
    const timeline = await indexManager.getTimelineSummary(scope, req.user.id);
    res.json({ timeline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analytics/groups - Aggregated group-wise taxonomy breakdown
 */
router.get('/analytics/groups', async (req, res) => {
  try {
    const scope = req.query.scope || 'all';
    const groups = await indexManager.getGroupSummary(scope, req.user.id);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== DOCUMENT DETAILS & DOWNLOAD =====================

/**
 * GET /api/documents/:id - Get specific document and decrypt/parse its content
 */
router.get('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docMeta = await indexManager.getDocumentById(id);

    if (!docMeta) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // 1. Download buffer from Telegram using fileId
    let buffer = await telegramService.downloadFile(docMeta.telegramFileId);

    // 2. Decrypt if encrypted in Zero-Knowledge Vault
    if (docMeta.security?.isEncrypted && docMeta.security?.iv && docMeta.security?.authTag) {
      try {
        buffer = decryptBuffer(buffer, docMeta.security.iv, docMeta.security.authTag);
      } catch (decryptErr) {
        console.error('Decryption error for doc', id, decryptErr.message);
        return res.status(500).json({
          error: `Zero-Knowledge Decryption Failed: Integrity check mismatch or invalid key.`,
        });
      }
    }

    // 3. Parse according to type
    const parsed = await parserService.parseBuffer(
      buffer,
      docMeta.filename || `${docMeta.title}.bin`,
      docMeta.mimeType || ''
    );

    res.json({
      metadata: docMeta,
      content: parsed,
    });
  } catch (err) {
    console.error('Error fetching document content:', err.message);
    res.status(500).json({ error: `Could not load document content: ${err.message}` });
  }
});

/**
 * GET /api/documents/:id/download - Stream decrypted file to user
 */
router.get('/documents/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const docMeta = await indexManager.getDocumentById(id);

    if (!docMeta) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Check fast-path decrypted buffer in RAM to serve range chunks in <1ms without re-decrypting
    let buffer = getCachedDecryptedBuffer(id);
    if (!buffer) {
      buffer = await telegramService.downloadFile(docMeta.telegramFileId);
      if (docMeta.security?.isEncrypted && docMeta.security?.iv && docMeta.security?.authTag) {
        buffer = decryptBuffer(buffer, docMeta.security.iv, docMeta.security.authTag);
      }
      setCachedDecryptedBuffer(id, buffer);
    }

    const ext = (docMeta.filename || '').split('.').pop().toLowerCase();
    const mimeMap = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      csv: 'text/csv; charset=utf-8',
      tsv: 'text/tab-separated-values; charset=utf-8',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      txt: 'text/plain; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      json: 'application/json; charset=utf-8',
      xml: 'application/xml; charset=utf-8',
      zip: 'application/zip',
    };

    const downloadMime =
      mimeMap[ext] ||
      (docMeta.mimeType && docMeta.mimeType !== 'application/octet-stream' ? docMeta.mimeType : 'application/octet-stream');

    res.setHeader('Content-Type', downloadMime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(docMeta.filename)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: `Download failed: ${err.message}` });
  }
});

/**
 * GET /api/documents/:id/view - Stream decrypted file inline for native PDF / media viewer
 */
router.get('/documents/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const docMeta = await indexManager.getDocumentById(id);

    if (!docMeta) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Check fast-path decrypted buffer in RAM to serve range chunks in <1ms without re-decrypting
    let buffer = getCachedDecryptedBuffer(id);
    if (!buffer) {
      buffer = await telegramService.downloadFile(docMeta.telegramFileId);
      if (docMeta.security?.isEncrypted && docMeta.security?.iv && docMeta.security?.authTag) {
        buffer = decryptBuffer(buffer, docMeta.security.iv, docMeta.security.authTag);
      }
      setCachedDecryptedBuffer(id, buffer);
    }

    const ext = (docMeta.filename || '').split('.').pop().toLowerCase();
    const mimeMap = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      csv: 'text/csv; charset=utf-8',
      tsv: 'text/tab-separated-values; charset=utf-8',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      txt: 'text/plain; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      json: 'application/json; charset=utf-8',
      xml: 'application/xml; charset=utf-8',
      zip: 'application/zip',
    };

    const contentType =
      mimeMap[ext] ||
      (docMeta.mimeType && docMeta.mimeType !== 'application/octet-stream' ? docMeta.mimeType : null) ||
      (docMeta.type === 'pdf' ? 'application/pdf' : 'application/octet-stream');

    // Handle HTTP 206 Partial Content (Bounded Range Chunking) for smooth progressive video/audio playback
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);

      // Bounded chunk streaming: 1.5 MB per range response prevents socket choking & eliminates video stutter
      const CHUNK_SIZE = 1536 * 1024; // 1.5 MB bounded chunk
      const maxEnd = Math.min(start + CHUNK_SIZE - 1, buffer.length - 1);
      const end = parts[1] ? Math.min(parseInt(parts[1], 10), buffer.length - 1) : maxEnd;

      const chunkSize = end - start + 1;
      const slice = buffer.subarray(start, end + 1);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(docMeta.filename)}"`,
        'Cache-Control': 'private, max-age=86400',
        'ETag': `"${docMeta.checksumSha256 || docMeta.id}"`,
      });
      return res.end(slice);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(docMeta.filename)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', `"${docMeta.checksumSha256 || docMeta.id}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: `View failed: ${err.message}` });
  }
});

// ===================== UPLOAD & INGESTION =====================

/**
 * POST /api/upload & POST /api/documents/upload - Upload, encrypt, and ingest (Supports Single & Multiple Files)
 * Treats every detected file as a distinct, independent file instance with its own AES-256-GCM encryption,
 * Telegram storage blob, and MongoDB document record.
 */
const handleUpload = (req, res) => {
  if (req.setTimeout) req.setTimeout(300000); // 5 minutes socket timeout for large file uploads
  upload.any()(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: 'A file exceeds the 20 MB Telegram limit. Please upload files under 20 MB.',
        });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const rawFiles = req.files && req.files.length > 0 ? req.files : (req.file ? [req.file] : []);

    if (rawFiles.length === 0) {
      return res.status(400).json({ error: 'No file(s) uploaded.' });
    }

    // Size limit check for all files before starting processing
    for (const f of rawFiles) {
      if (f.size > config.maxFileSizeBytes) {
        return res.status(400).json({
          error: `File "${f.originalname}" (${(f.size / (1024 * 1024)).toFixed(1)} MB) exceeds 20 MB Telegram limit.`,
        });
      }
    }

    try {
      const createdDocs = [];
      const parsedList = [];

      // Process each file sequentially to avoid Telegram API 429 rate limits
      for (let i = 0; i < rawFiles.length; i++) {
        const file = rawFiles[i];
        let fileBuffer = file.buffer;
        let originalName = file.originalname;
        try {
          // Fix Busboy/Multer Latin-1 parsing of UTF-8 filenames (e.g. "ï½" mojibake for "｜")
          const fixedUtf8 = Buffer.from(file.originalname, 'latin1').toString('utf8');
          if (!fixedUtf8.includes('\uFFFD') && fixedUtf8 !== file.originalname) {
            originalName = fixedUtf8;
          }
        } catch (_) {}
        const mimeType = file.mimetype || 'application/octet-stream';
        let size = file.size;

        // 0. Smart Adaptive Compression for Media (Videos, Audio, High-Res Images up to 50 MB)
        let effectiveName = originalName;
        let effectiveMime = mimeType;
        try {
          const optResult = await mediaOptimizer.optimizeMedia(fileBuffer, originalName, mimeType);
          if (optResult.compressed) {
            fileBuffer = optResult.buffer;
            size = optResult.newSize;
            effectiveName = optResult.filename || originalName;
            effectiveMime = optResult.mimeType || mimeType;
          }
        } catch (optErr) {
          console.warn('[Upload] Media optimization fallback:', optErr.message);
        }

        // 0b. Critical Telegram Safe Retrieval Boundary (19.5 MB ceiling)
        // Standard Telegram Bot API getFile has a hard 20 MB ceiling for downloads.
        const TELEGRAM_SAFE_CEILING = 19.5 * 1024 * 1024;
        if (fileBuffer.length > TELEGRAM_SAFE_CEILING) {
          const sizeMb = (fileBuffer.length / (1024 * 1024)).toFixed(1);
          return res.status(400).json({
            error: `File "${originalName}" is ${sizeMb} MB after processing, exceeding Telegram's 20 MB retrieval limit. Smart compression automatically reduces video/audio/image uploads up to 50 MB to fit under 20 MB. For documents, PDFs, or archives (.zip), files must be under 20 MB.`,
          });
        }

        // 1. Calculate SHA-256 for integrity & deduplication
        const checksum = computeChecksum(fileBuffer);

        // 2. Parse in memory to extract text and stats
        const parsed = await parserService.parseBuffer(fileBuffer, effectiveName, effectiveMime);
        parsedList.push(parsed);

        // 3. Multi-Dimensional Classification (Scope, Security, Group, Temporal)
        const userOverrides = {
          scope: req.body.scope,
          securityLevel: req.body.securityLevel,
          group: req.body.group,
          subGroup: req.body.subGroup,
          documentDate: req.body.documentDate,
          tags: req.body.tags
            ? (typeof req.body.tags === 'string' ? JSON.parse(req.body.tags || '[]') : req.body.tags)
            : [],
        };

        const extractedSample = parsed.text || (parsed.headers ? parsed.headers.join(' ') : '');
        const classification = classifyDocument(originalName, extractedSample, userOverrides);

        const docId = uuidv4 ? uuidv4() : `${Date.now()}_${i}`;

        // 4. Zero-Knowledge Encryption - INDIVIDUAL IV and AuthTag per file instance
        const shouldEncrypt = classification.securityLevel !== 'public';
        let uploadPayload = fileBuffer;
        let uploadFilename = originalName;
        let encryptionMeta = {
          isEncrypted: false,
          iv: null,
          authTag: null,
        };

        if (shouldEncrypt) {
          const encrypted = encryptBuffer(fileBuffer);
          uploadPayload = encrypted.encryptedBuffer;
          uploadFilename = `vault_${docId.slice(0, 8)}.enc`;
          encryptionMeta = {
            isEncrypted: true,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
          };
        }

        // 5. Stream Encrypted Blob to Telegram Channel
        const tgCaption = shouldEncrypt
          ? `🔒 [Vault Encrypted] ${classification.group.toUpperCase()}/${classification.scope.toUpperCase()}\nRef: ${docId.slice(0, 8)} • SHA: ${checksum.slice(0, 8)}`
          : `📄 TeleDoc: ${originalName} (${(size / 1024).toFixed(1)} KB)`;

        const tgRes = await telegramService.uploadDocument(uploadPayload, uploadFilename, tgCaption);

        // 6. Create preview snippet
        let snippet = '';
        if (parsed.format === 'document' && parsed.text) {
          snippet = parsed.text.substring(0, 160).replace(/\s+/g, ' ');
        } else if (parsed.format === 'spreadsheet' && parsed.headers) {
          snippet = `${parsed.totalRows} rows • Headers: ${parsed.headers.slice(0, 4).join(', ')}`;
        } else if (parsed.format === 'image') {
          snippet = `Image (${(size / 1024).toFixed(1)} KB)`;
        } else if (parsed.format === 'media') {
          snippet = `${parsed.type === 'video' ? 'Video' : 'Audio'} recording (${(size / 1024).toFixed(1)} KB)`;
        } else {
          snippet = `Binary File (${(size / (1024 * 1024)).toFixed(2)} MB)`;
        }

        // 7. Save independent document instance to MongoDB
        const docRecord = {
          id: docId,
          userId: req.user ? req.user.id : 'default_user',
          title: originalName.replace(/\.[^/.]+$/, ''),
          filename: effectiveName,
          originalFilename: originalName,
          type: parsed.type,
          format: parsed.format,
          fileSize: size,
          wordCount: parsed.wordCount || 0,
          pageCount: parsed.pageCount || 1,
          telegramFileId: tgRes.fileId,
          telegramMessageId: tgRes.messageId,
          mimeType: effectiveMime,
          warning: parsed.warning || null,
          previewSnippet: snippet,
          checksumSha256: checksum,
          collectionId: req.body.collectionId || null,
          collectionName: req.body.collectionName || 'Unassigned',
          scope: classification.scope,
          security: {
            level: classification.securityLevel,
            isEncrypted: encryptionMeta.isEncrypted,
            iv: encryptionMeta.iv,
            authTag: encryptionMeta.authTag,
          },
          temporal: {
            documentDate: classification.documentDate,
            year: classification.documentDate.getFullYear(),
            month: classification.documentDate.getMonth() + 1,
          },
          taxonomy: {
            group: classification.group,
            subGroup: classification.subGroup,
            tags: classification.tags,
          },
          createdAt: new Date().toISOString(),
        };

        const savedDoc = await indexManager.addDocument(docRecord);
        createdDocs.push(savedDoc);
      }

      res.status(201).json({
        success: true,
        count: createdDocs.length,
        documents: createdDocs,
        document: createdDocs[0],
        content: parsedList[0],
        message: `Successfully processed ${createdDocs.length} individual file instance(s).`,
      });
    } catch (uploadErr) {
      console.error('Upload processing error:', uploadErr.message);
      res.status(500).json({ error: uploadErr.message });
    }
  });
};

router.post('/upload', handleUpload);
router.post('/documents/upload', handleUpload);

/**
 * POST /api/google-link & POST /api/google/ingest - Ingest Google Doc or Sheet
 */
const handleGoogleIngest = async (req, res) => {
  try {
    const { url, title, collectionId, collectionName, groupId, group, scope } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Please provide a valid Google link.' });
    }

    let cleanTitle = title && typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      cleanTitle = `Google Workspace Doc (${new Date().toLocaleDateString()})`;
    }

    // 1. Fetch and rewrite Google resource
    const googleRes = await googleLinkService.fetchGoogleResource(url, cleanTitle);
    const parsed = googleRes.parsedContent;
    const docId = uuidv4 ? uuidv4() : Date.now().toString();

    // 2. Classify
    const classification = classifyDocument(
      googleRes.filename,
      parsed.text || '',
      {
        scope: scope || req.body.scope || 'professional',
        group: group || req.body.group || 'general',
      }
    );

    // 3. Encrypt buffer before Telegram
    const encrypted = encryptBuffer(googleRes.buffer);
    const uploadFilename = `vault_g_${docId.slice(0, 8)}.enc`;
    const caption = `🔒 [Vault Encrypted Google Snapshot] ${cleanTitle}\nRef: ${docId.slice(0, 8)}`;

    const tgRes = await telegramService.uploadDocument(
      encrypted.encryptedBuffer,
      uploadFilename,
      caption
    );

    // 4. Create snippet
    let snippet = '';
    if (parsed.format === 'document' && parsed.text) {
      snippet = parsed.text.substring(0, 160).replace(/\s+/g, ' ');
    } else if (parsed.format === 'spreadsheet' && parsed.headers) {
      snippet = `${parsed.totalRows} rows • Headers: ${parsed.headers.slice(0, 4).join(', ')}`;
    }

    // 5. Save to MongoDB
    const docRecord = {
      id: docId,
      userId: req.user ? req.user.id : 'default_user',
      title: cleanTitle,
      filename: googleRes.filename,
      type: googleRes.type,
      format: parsed.format,
      fileSize: googleRes.buffer.length,
      wordCount: parsed.wordCount || 0,
      pageCount: parsed.pageCount || 1,
      telegramFileId: tgRes.fileId,
      telegramMessageId: tgRes.messageId,
      mimeType: googleRes.type === 'google_doc' ? 'text/plain' : 'text/csv',
      originalUrl: googleRes.originalUrl,
      warning: parsed.warning || null,
      previewSnippet: snippet,
      collectionId: collectionId || req.body.collectionId || null,
      collectionName: collectionName || req.body.collectionName || 'Unassigned',
      groupId: groupId || req.body.groupId || null,
      scope: classification.scope,
      security: {
        level: classification.securityLevel,
        isEncrypted: true,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      },
      temporal: {
        documentDate: classification.documentDate,
        year: classification.documentDate.getFullYear(),
        month: classification.documentDate.getMonth() + 1,
      },
      taxonomy: {
        group: group || classification.group,
        subGroup: classification.subGroup,
        tags: classification.tags,
      },
      createdAt: new Date().toISOString(),
    };

    const savedDoc = await indexManager.addDocument(docRecord);

    res.status(201).json({
      success: true,
      document: savedDoc,
      content: parsed,
    });
  } catch (err) {
    console.error('Google link ingestion error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

router.post('/google-link', handleGoogleIngest);
router.post('/google/ingest', handleGoogleIngest);

/**
 * DELETE /api/documents/:id - Delete document from Telegram and MongoDB
 */
router.delete('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await indexManager.removeDocument(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({ success: true, message: 'Document removed successfully from MongoDB and Telegram.' });
  } catch (err) {
    console.error('Error deleting document:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
