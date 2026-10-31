const mongooseLib = require('mongoose');

const DocumentSchema = new mongooseLib.Schema(
  {
    // Unique Identifier for UI / API
    id: {
      type: String,
      required: true,
      unique: true,
    },
    // User / Multi-tenancy ownership
    userId: {
      type: String,
      required: true,
      default: 'default_user',
    },
    title: { type: String, required: true, trim: true },
    filename: { type: String, required: true },
    type: { type: String, required: true },
    format: { type: String, required: true },
    fileSize: { type: Number, required: true },
    wordCount: { type: Number, default: 0 },
    pageCount: { type: Number, default: 1 },

    // Telegram Vault Pointers (Actual payload stored in Telegram, 0 MB in Mongo)
    telegramFileId: { type: String, required: true },
    telegramMessageId: { type: Number, required: true },
    mimeType: { type: String, default: 'application/octet-stream' },
    previewSnippet: { type: String, default: '' },
    originalUrl: { type: String, default: null },
    warning: { type: String, default: null },

    // Deduplication Fingerprint
    checksumSha256: { type: String, default: null },

    // Organizational Hierarchy
    collectionId: { type: String, default: null },
    collectionName: { type: String, default: 'Unassigned' },
    groupId: { type: String, default: null },
    order: { type: Number, default: 0 },

    // Categorization & Scope
    scope: {
      type: String,
      enum: ['personal', 'professional'],
      default: 'professional',
    },
    security: {
      level: {
        type: String,
        enum: ['public', 'internal', 'confidential', 'strictly_confidential'],
        default: 'confidential',
      },
      isEncrypted: { type: Boolean, default: true },
      iv: { type: String, default: null },
      authTag: { type: String, default: null },
    },
    temporal: {
      documentDate: { type: Date, default: Date.now },
      year: { type: Number },
      month: { type: Number },
      retentionExpiresAt: { type: Date, default: null },
    },
    taxonomy: {
      group: { type: String, default: 'general' },
      subGroup: { type: String, default: 'general' },
      tags: [{ type: String, lowercase: true, trim: true }],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Pre-save hook: auto-compute year and month from documentDate
DocumentSchema.pre('save', function (next) {
  if (this.temporal && this.temporal.documentDate) {
    const d = new Date(this.temporal.documentDate);
    this.temporal.year = d.getFullYear();
    this.temporal.month = d.getMonth() + 1;
  }
  next();
});

// ================= ULTRA-LEAN COMPOUND INDEXES =================
// 1. Collection queries: db.documents.find({ userId, collectionId })
DocumentSchema.index({ userId: 1, collectionId: 1 });

// 3. Group queries: db.documents.find({ userId, groupId })
DocumentSchema.index({ userId: 1, groupId: 1 });

// 4. Faceted search & sorting by scope, category & timeline:
DocumentSchema.index({ userId: 1, scope: 1, 'taxonomy.group': 1, 'temporal.documentDate': -1 });

// 5. Fast deduplication lookup:
DocumentSchema.index({ userId: 1, checksumSha256: 1 });

// 6. Lean text search index (indexes title & tags only; no 20KB body text bloat):
DocumentSchema.index(
  {
    title: 'text',
    filename: 'text',
    'taxonomy.tags': 'text',
  },
  {
    name: 'document_text_search',
    weights: { title: 10, 'taxonomy.tags': 5, filename: 2 },
  }
);

module.exports = mongooseLib.model('Document', DocumentSchema);
