const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uuidv4 = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
const { connectDB } = require('../db/connection');
const DocumentModel = require('../models/Document');
const CollectionModel = require('../models/Collection');
const GroupModel = require('../models/Group');
const telegramService = require('../services/telegramService');
const config = require('../config');

const CACHE_DIR = path.resolve(__dirname, '../../.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'index.json');

class IndexManager {
  constructor() {
    this.isMongoConnected = false;
    this.memoryDocs = []; // Fallback in-memory cache if MongoDB is offline
    this.memoryCollections = [];
    this.memoryGroups = [];
  }

  /**
   * Initialize MongoDB connection and import any legacy JSON cache
   */
  async init() {
    console.log('[IndexManager] Initializing MongoDB Document & Collection Manager...');

    try {
      await connectDB();
      this.isMongoConnected = true;
      console.log('[IndexManager] Connected to MongoDB successfully.');

      // Migrate legacy cache if exists
      await this.migrateLegacyCache();
    } catch (err) {
      console.warn('[IndexManager] MongoDB connection warning. Running with local cache fallback:', err.message);
      this.loadLocalCache();
    }
  }

  /**
   * Migrate any existing JSON cache documents into MongoDB
   */
  async migrateLegacyCache() {
    if (!fs.existsSync(CACHE_FILE)) return;

    try {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
        console.log(`[IndexManager] Found ${parsed.documents.length} cached docs. Checking MongoDB synchronization...`);
        for (const doc of parsed.documents) {
          const exists = await DocumentModel.findOne({ id: doc.id });
          if (!exists) {
            const docDate = doc.createdAt ? new Date(doc.createdAt) : new Date();
            await DocumentModel.create({
              ...doc,
              temporal: {
                documentDate: docDate,
                year: docDate.getFullYear(),
                month: docDate.getMonth() + 1,
              },
              scope: doc.scope || 'professional',
              security: {
                level: doc.securityLevel || 'internal',
                isEncrypted: false,
              },
              taxonomy: {
                group: doc.group || 'general',
                subGroup: doc.subGroup || 'general',
                tags: doc.tags || [],
              },
            });
            console.log(`[IndexManager] Migrated doc "${doc.title}" into MongoDB.`);
          }
        }
      }
    } catch (err) {
      console.warn('[IndexManager] Migration warning:', err.message);
    }
  }

  loadLocalCache() {
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.documents)) {
          this.memoryDocs = parsed.documents;
        }
      } catch (err) {
        console.warn('[IndexManager] Local cache read error:', err.message);
      }
    }
  }

  /**
   * List documents with multi-dimensional filtering
   * @param {Object} filters - { scope, group, subGroup, securityLevel, year, month, search, tag, collectionId }
   * @param {String} userId - User identifier for data isolation
   */
  async getAllDocuments(filters = {}, userId = null) {
    if (this.isMongoConnected) {
      const query = {};

      if (userId) {
        query.userId = userId;
      }

      // 1. Scope Filter (personal vs professional)
      if (filters.scope && filters.scope !== 'all') {
        query.scope = filters.scope;
      }

      // 2. Collection Filter
      if (filters.collectionId) {
        if (filters.collectionId === 'unassigned') {
          query.$or = [{ collectionId: null }, { collectionId: '' }];
        } else if (filters.collectionId !== 'all') {
          query.collectionId = filters.collectionId;
        }
      }

      // 3. Security Level Filter
      if (filters.securityLevel) {
        query['security.level'] = filters.securityLevel;
      }

      // 4. Group / Category Filter
      if (filters.group && filters.group !== 'all') {
        query['taxonomy.group'] = filters.group;
      }
      if (filters.subGroup) {
        query['taxonomy.subGroup'] = filters.subGroup;
      }

      // 5. Time-Wise Filter
      if (filters.year) {
        query['temporal.year'] = parseInt(filters.year, 10);
      }
      if (filters.month) {
        query['temporal.month'] = parseInt(filters.month, 10);
      }

      // 6. Tag Filter
      if (filters.tag) {
        query['taxonomy.tags'] = filters.tag.toLowerCase();
      }

      // 7. Text Search (title, filename, tags, or extracted content)
      if (filters.search && filters.search.trim()) {
        const regex = new RegExp(filters.search.trim(), 'i');
        query.$or = [
          { title: regex },
          { filename: regex },
          { collectionName: regex },
          { 'taxonomy.tags': regex },
        ];
      }

      const docs = await DocumentModel.find(query).sort({ 'temporal.documentDate': -1, createdAt: -1 }).lean();
      return docs;
    }

    // Fallback: in-memory filter
    return [...this.memoryDocs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Find document by ID
   */
  async getDocumentById(id) {
    if (this.isMongoConnected) {
      return await DocumentModel.findOne({ id }).lean();
    }
    return this.memoryDocs.find((doc) => doc.id === id) || null;
  }

  /**
   * Add a new document record
   */
  async addDocument(docRecord, userId = null) {
    if (userId) {
      docRecord.userId = userId;
    }

    if (this.isMongoConnected) {
      const doc = await DocumentModel.findOneAndUpdate(
        { id: docRecord.id },
        { $set: docRecord },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      ).lean();
      return doc;
    }

    // Fallback
    this.memoryDocs = this.memoryDocs.filter((d) => d.id !== docRecord.id);
    this.memoryDocs.unshift(docRecord);
    return docRecord;
  }

  /**
   * Claim any legacy unowned documents for first registered user
   */
  async claimLegacyDocuments(userId) {
    if (!userId) return;
    if (this.isMongoConnected) {
      await DocumentModel.updateMany(
        { $or: [{ userId: 'default_user' }, { userId: { $exists: false } }, { userId: null }] },
        { $set: { userId } }
      );
      await CollectionModel.updateMany(
        { $or: [{ userId: 'default_user' }, { userId: { $exists: false } }, { userId: null }] },
        { $set: { userId } }
      );
    } else {
      this.memoryDocs.forEach((d) => {
        if (!d.userId || d.userId === 'default_user') d.userId = userId;
      });
      this.memoryCollections.forEach((c) => {
        if (!c.userId || c.userId === 'default_user') c.userId = userId;
      });
    }
  }

  /**
   * Update document metadata
   */
  async updateDocument(id, updates) {
    if (this.isMongoConnected) {
      return await DocumentModel.findOneAndUpdate(
        { id },
        { $set: updates },
        { returnDocument: 'after' }
      ).lean();
    }

    const idx = this.memoryDocs.findIndex((d) => d.id === id);
    if (idx !== -1) {
      this.memoryDocs[idx] = { ...this.memoryDocs[idx], ...updates };
      return this.memoryDocs[idx];
    }
    return null;
  }

  /**
   * Remove a document by ID and delete its blob from Telegram
   */
  async removeDocument(id) {
    let doc = null;

    if (this.isMongoConnected) {
      doc = await DocumentModel.findOne({ id }).lean();
      if (!doc) return false;
      await DocumentModel.deleteOne({ id });
    } else {
      doc = this.memoryDocs.find((d) => d.id === id);
      if (!doc) return false;
      this.memoryDocs = this.memoryDocs.filter((d) => d.id !== id);
    }

    // Delete document blob from Telegram channel
    if (doc.telegramMessageId) {
      try {
        await telegramService.deleteMessage(doc.telegramMessageId);
      } catch (tgErr) {
        console.warn(`[IndexManager] Notice: Telegram message ${doc.telegramMessageId} cleanup skipped:`, tgErr.message);
      }
    }

    return true;
  }

  // ===================== COLLECTION METHODS =====================

  /**
   * Get all collections with document counts
   */
  async getAllCollections(scope = null, userId = null) {
    if (this.isMongoConnected) {
      const match = {};
      if (scope && scope !== 'all') {
        match.scope = scope;
      }
      if (userId) {
        match.userId = userId;
      }

      const collections = await CollectionModel.find(match).sort({ createdAt: -1 }).lean();

      // Aggregate counts per collection for this user
      const docMatch = { collectionId: { $ne: null } };
      if (userId) docMatch.userId = userId;

      const counts = await DocumentModel.aggregate([
        { $match: docMatch },
        { $group: { _id: '$collectionId', count: { $sum: 1 } } },
      ]);

      const countMap = {};
      counts.forEach((c) => {
        countMap[c._id] = c.count;
      });

      return collections.map((col) => ({
        ...col,
        documentCount: countMap[col.id] || 0,
      }));
    }

    let cols = this.memoryCollections;
    if (userId) cols = cols.filter((c) => !c.userId || c.userId === userId);
    return cols;
  }

  /**
   * Create a new collection
   */
  async createCollection(
    {
      name,
      scope = 'professional',
      color = '#0284c7',
      description = '',
      securityLevel = 'confidential',
      groupId = null,
      groupName = 'General',
    },
    userId = 'default_user'
  ) {
    const colId = uuidv4 ? uuidv4() : Date.now().toString();

    let resolvedGroupId = groupId || null;
    let resolvedGroupName = groupName || 'General';

    if (this.isMongoConnected) {
      if (resolvedGroupId && (!resolvedGroupName || resolvedGroupName === 'General')) {
        const grp = await GroupModel.findOne({ id: resolvedGroupId, userId }).lean();
        if (grp) resolvedGroupName = grp.name;
      }

      const col = await CollectionModel.create({
        id: colId,
        userId: userId || 'default_user',
        name: name.trim(),
        scope,
        color,
        description: description ? description.trim() : '',
        securityLevel,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
      });
      return col.toJSON();
    }

    const item = {
      id: colId,
      userId: userId || 'default_user',
      name: name.trim(),
      scope,
      color,
      description: description ? description.trim() : '',
      securityLevel,
      groupId: resolvedGroupId,
      groupName: resolvedGroupName,
      documentCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.memoryCollections.unshift(item);
    return item;
  }

  /**
   * Get single collection by ID with file counts & size
   */
  async getCollectionById(id) {
    if (this.isMongoConnected) {
      const col = await CollectionModel.findOne({ id }).lean();
      if (!col) return null;

      const docs = await DocumentModel.find({ collectionId: id }).lean();
      const totalBytes = docs.reduce((acc, d) => acc + (d.fileSize || 0), 0);

      return {
        ...col,
        documentCount: docs.length,
        totalBytes,
        documents: docs,
      };
    }

    const col = this.memoryCollections.find((c) => c.id === id);
    if (!col) return null;
    const docs = this.memoryDocs.filter((d) => d.collectionId === id);
    return {
      ...col,
      documentCount: docs.length,
      totalBytes: docs.reduce((acc, d) => acc + (d.fileSize || 0), 0),
      documents: docs,
    };
  }

  /**
   * Update collection metadata and cascade rename/scope/group to associated documents
   */
  async updateCollection(id, updates = {}) {
    const cleanUpdates = {};
    if (updates.name && updates.name.trim()) cleanUpdates.name = updates.name.trim();
    if (updates.scope) cleanUpdates.scope = updates.scope;
    if (updates.color) cleanUpdates.color = updates.color;
    if (updates.description !== undefined) cleanUpdates.description = updates.description.trim();
    if (updates.securityLevel) cleanUpdates.securityLevel = updates.securityLevel;
    if (updates.groupId !== undefined) cleanUpdates.groupId = updates.groupId;
    if (updates.groupName !== undefined) cleanUpdates.groupName = updates.groupName;

    if (this.isMongoConnected) {
      const updated = await CollectionModel.findOneAndUpdate(
        { id },
        { $set: cleanUpdates },
        { returnDocument: 'after' }
      ).lean();

      if (!updated) return null;

      // Synchronize associated documents if name, scope, or group changed
      const docUpdates = {};
      if (cleanUpdates.name) docUpdates.collectionName = cleanUpdates.name;
      if (cleanUpdates.scope) docUpdates.scope = cleanUpdates.scope;
      if (cleanUpdates.groupId !== undefined) docUpdates.groupId = cleanUpdates.groupId;
      if (cleanUpdates.groupName !== undefined) docUpdates['taxonomy.group'] = cleanUpdates.groupName.toLowerCase();

      if (Object.keys(docUpdates).length > 0) {
        await DocumentModel.updateMany({ collectionId: id }, { $set: docUpdates });
      }

      return updated;
    }

    const idx = this.memoryCollections.findIndex((c) => c.id === id);
    if (idx !== -1) {
      this.memoryCollections[idx] = { ...this.memoryCollections[idx], ...cleanUpdates };
      if (
        cleanUpdates.name ||
        cleanUpdates.scope ||
        cleanUpdates.groupId !== undefined ||
        cleanUpdates.groupName !== undefined
      ) {
        this.memoryDocs.forEach((d) => {
          if (d.collectionId === id) {
            if (cleanUpdates.name) d.collectionName = cleanUpdates.name;
            if (cleanUpdates.scope) d.scope = cleanUpdates.scope;
            if (cleanUpdates.groupId !== undefined) d.groupId = cleanUpdates.groupId;
            if (cleanUpdates.groupName !== undefined) {
              if (!d.taxonomy) d.taxonomy = {};
              d.taxonomy.group = cleanUpdates.groupName.toLowerCase();
            }
          }
        });
      }
      return this.memoryCollections[idx];
    }
    return null;
  }

  /**
   * Delete a collection.
   * If cascade === true, deletes all documents in collection from Telegram and Mongo.
   * If cascade === false, unassigns documents and moves them to Inbox.
   */
  async deleteCollection(id, { cascade = false } = {}) {
    if (this.isMongoConnected) {
      if (cascade) {
        // Find and delete every document (including Telegram binary)
        const docs = await DocumentModel.find({ collectionId: id }).lean();
        for (const doc of docs) {
          await this.removeDocument(doc.id);
        }
      } else {
        // Unassign to Inbox
        await DocumentModel.updateMany(
          { collectionId: id },
          { $set: { collectionId: null, collectionName: 'Unassigned' } }
        );
      }

      await CollectionModel.deleteOne({ id });
      return true;
    }

    // In-memory fallback
    if (cascade) {
      const docsToDelete = this.memoryDocs.filter((d) => d.collectionId === id);
      for (const doc of docsToDelete) {
        await this.removeDocument(doc.id);
      }
    } else {
      this.memoryDocs.forEach((d) => {
        if (d.collectionId === id) {
          d.collectionId = null;
          d.collectionName = 'Unassigned';
        }
      });
    }

    this.memoryCollections = this.memoryCollections.filter((c) => c.id !== id);
    return true;
  }

  /**
   * Move a document to a collection (or unassign to Inbox).
   * Validates target collection existence and synchronizes name and scope.
   */
  async assignDocumentCollection(docId, collectionId, customName = null) {
    let targetCollectionId = null;
    let targetCollectionName = 'Unassigned';
    let targetScope = null;

    if (collectionId && collectionId !== 'unassigned' && collectionId !== '') {
      if (this.isMongoConnected) {
        const col = await CollectionModel.findOne({ id: collectionId }).lean();
        if (!col) {
          throw new Error(`Target collection '${collectionId}' does not exist.`);
        }
        targetCollectionId = col.id;
        targetCollectionName = col.name;
        targetScope = col.scope;
      } else {
        const col = this.memoryCollections.find((c) => c.id === collectionId);
        if (col) {
          targetCollectionId = col.id;
          targetCollectionName = col.name;
          targetScope = col.scope;
        }
      }
    }

    const updates = {
      collectionId: targetCollectionId,
      collectionName: targetCollectionName,
    };

    if (targetScope) {
      updates.scope = targetScope;
    }

    return await this.updateDocument(docId, updates);
  }

  /**
   * Batch move multiple documents to a collection
   */
  async batchMoveDocuments(docIds = [], collectionId = null) {
    if (!Array.isArray(docIds) || docIds.length === 0) return { modifiedCount: 0 };

    let targetCollectionId = null;
    let targetCollectionName = 'Unassigned';
    let targetScope = null;

    if (collectionId && collectionId !== 'unassigned' && collectionId !== '') {
      if (this.isMongoConnected) {
        const col = await CollectionModel.findOne({ id: collectionId }).lean();
        if (!col) {
          throw new Error(`Target collection '${collectionId}' does not exist.`);
        }
        targetCollectionId = col.id;
        targetCollectionName = col.name;
        targetScope = col.scope;
      } else {
        const col = this.memoryCollections.find((c) => c.id === collectionId);
        if (col) {
          targetCollectionId = col.id;
          targetCollectionName = col.name;
          targetScope = col.scope;
        }
      }
    }

    const updates = {
      collectionId: targetCollectionId,
      collectionName: targetCollectionName,
    };
    if (targetScope) {
      updates.scope = targetScope;
    }

    if (this.isMongoConnected) {
      const res = await DocumentModel.updateMany(
        { id: { $in: docIds } },
        { $set: updates }
      );
      return { modifiedCount: res.modifiedCount, collectionName: targetCollectionName };
    }

    // Fallback in-memory
    let count = 0;
    this.memoryDocs.forEach((d) => {
      if (docIds.includes(d.id)) {
        d.collectionId = targetCollectionId;
        d.collectionName = targetCollectionName;
        if (targetScope) d.scope = targetScope;
        count++;
      }
    });
    return { modifiedCount: count, collectionName: targetCollectionName };
  }

  // ===================== ANALYTICS =====================

  /**
   * Aggregate Time-Wise Timeline (Group by Year & Month)
   */
  async getTimelineSummary(scope = null) {
    if (!this.isMongoConnected) return [];

    const match = {};
    if (scope && scope !== 'all') {
      match.scope = scope;
    }

    return await DocumentModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            year: '$temporal.year',
            month: '$temporal.month',
          },
          count: { $sum: 1 },
          totalBytes: { $sum: '$fileSize' },
        },
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
    ]);
  }

  /**
   * Aggregate Group-Wise Taxonomy (Group by Domain Category)
   */
  async getGroupSummary(scope = null) {
    if (!this.isMongoConnected) return [];

    const match = {};
    if (scope && scope !== 'all') {
      match.scope = scope;
    }

    return await DocumentModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            group: '$taxonomy.group',
            subGroup: '$taxonomy.subGroup',
          },
          count: { $sum: 1 },
          totalBytes: { $sum: '$fileSize' },
        },
      },
      { $sort: { '_id.group': 1, count: -1 } },
    ]);
  }

  // ===================== GROUP CRUD METHODS (FILE & COLLECTION) =====================

  /**
   * Seed default system groups if user has none (Disabled: Users create authentic groups)
   */
  async ensureDefaultGroups(userId = 'default_user') {
    // Zero hardcoded groups. All groups are dynamically created and managed by the user.
    return;
  }

  /**
   * List all groups with member Collection & File counts
   */
  async getAllGroups(scope = null, userId = 'default_user') {
    if (this.isMongoConnected) {
      const match = { userId };
      if (scope && scope !== 'all') {
        match.$or = [{ scope }, { scope: 'all' }];
      }

      const groups = await GroupModel.find(match).sort({ createdAt: 1 }).lean();

      // Aggregate collections count per group
      const colAgg = await CollectionModel.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: '$groupId',
            count: { $sum: 1 },
          },
        },
      ]);
      const colCountMap = {};
      colAgg.forEach((c) => {
        if (c._id) colCountMap[c._id] = c.count;
      });

      // Aggregate documents count & totalBytes per group (by groupId or taxonomy.group)
      const docAgg = await DocumentModel.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: '$groupId',
            groupName: { $first: '$taxonomy.group' },
            count: { $sum: 1 },
            totalBytes: { $sum: '$fileSize' },
          },
        },
      ]);
      const docCountMap = {};
      const docBytesMap = {};
      docAgg.forEach((d) => {
        if (d._id) {
          docCountMap[d._id] = d.count;
          docBytesMap[d._id] = d.totalBytes;
        }
      });

      return groups.map((g) => {
        // Also match by lowercase slug or name fallback
        const fileCount = docCountMap[g.id] || 0;
        const totalBytes = docBytesMap[g.id] || 0;
        const collectionCount = colCountMap[g.id] || 0;

        return {
          ...g,
          collectionCount,
          fileCount,
          totalBytes,
          totalItems: collectionCount + fileCount,
        };
      });
    }

    // In-memory fallback
    let userGroups = this.memoryGroups.filter((g) => g.userId === userId);
    if (scope && scope !== 'all') {
      userGroups = userGroups.filter((g) => g.scope === scope || g.scope === 'all');
    }

    return userGroups.map((g) => {
      const colCount = this.memoryCollections.filter((c) => c.userId === userId && c.groupId === g.id).length;
      const docs = this.memoryDocs.filter((d) => d.userId === userId && (d.groupId === g.id || d.taxonomy?.group === g.name.toLowerCase()));
      const totalBytes = docs.reduce((acc, d) => acc + (d.fileSize || 0), 0);

      return {
        ...g,
        collectionCount: colCount,
        fileCount: docs.length,
        totalBytes,
        totalItems: colCount + docs.length,
      };
    });
  }

  /**
   * Get single group details with member collections and documents
   */
  async getGroupById(id, userId = 'default_user') {
    if (this.isMongoConnected) {
      const group = await GroupModel.findOne({ id, userId }).lean();
      if (!group) return null;

      // Find member collections
      const collections = await CollectionModel.find({
        userId,
        $or: [{ groupId: id }, { groupName: group.name }],
      }).lean();

      // Find member documents (either explicitly linked by groupId or matching group name)
      const documents = await DocumentModel.find({
        userId,
        $or: [{ groupId: id }, { 'taxonomy.group': group.name.toLowerCase() }, { 'taxonomy.group': group.slug }],
      }).lean();

      const totalBytes = documents.reduce((acc, d) => acc + (d.fileSize || 0), 0);

      return {
        ...group,
        collectionCount: collections.length,
        fileCount: documents.length,
        totalBytes,
        collections,
        documents,
      };
    }

    const group = this.memoryGroups.find((g) => g.id === id && g.userId === userId);
    if (!group) return null;

    const collections = this.memoryCollections.filter((c) => c.userId === userId && (c.groupId === id || c.groupName === group.name));
    const documents = this.memoryDocs.filter(
      (d) => d.userId === userId && (d.groupId === id || d.taxonomy?.group === group.name.toLowerCase() || d.taxonomy?.group === group.slug)
    );
    const totalBytes = documents.reduce((acc, d) => acc + (d.fileSize || 0), 0);

    return {
      ...group,
      collectionCount: collections.length,
      fileCount: documents.length,
      totalBytes,
      collections,
      documents,
    };
  }

  /**
   * Create a new group
   */
  async createGroup({ name, description = '', color = '#6366f1', icon = 'FolderKanban', scope = 'all' }, userId = 'default_user') {
    if (!name || !name.trim()) {
      throw new Error('Group name is required.');
    }

    const cleanName = name.trim();
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const groupId = `grp_${uuidv4().slice(0, 8)}`;

    if (this.isMongoConnected) {
      const created = await GroupModel.create({
        id: groupId,
        userId,
        name: cleanName,
        slug,
        description: description ? description.trim() : '',
        color: color || '#6366f1',
        icon: icon || 'FolderKanban',
        scope: scope || 'all',
        isSystem: false,
      });

      return {
        ...created.toJSON(),
        collectionCount: 0,
        fileCount: 0,
        totalBytes: 0,
      };
    }

    const item = {
      id: groupId,
      userId,
      name: cleanName,
      slug,
      description: description ? description.trim() : '',
      color: color || '#6366f1',
      icon: icon || 'FolderKanban',
      scope: scope || 'all',
      isSystem: false,
      collectionCount: 0,
      fileCount: 0,
      totalBytes: 0,
      createdAt: new Date().toISOString(),
    };
    this.memoryGroups.push(item);
    return item;
  }

  /**
   * Update a group with atomic cascade to all member collections & documents
   */
  async updateGroup(id, updates = {}, userId = 'default_user') {
    const cleanUpdates = {};
    if (updates.name && updates.name.trim()) {
      cleanUpdates.name = updates.name.trim();
      cleanUpdates.slug = cleanUpdates.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    if (updates.description !== undefined) cleanUpdates.description = updates.description.trim();
    if (updates.color) cleanUpdates.color = updates.color;
    if (updates.icon) cleanUpdates.icon = updates.icon;
    if (updates.scope) cleanUpdates.scope = updates.scope;

    if (this.isMongoConnected) {
      const updated = await GroupModel.findOneAndUpdate(
        { id, userId },
        { $set: cleanUpdates },
        { returnDocument: 'after' }
      ).lean();

      if (!updated) return null;

      // Cascade group rename to member collections and documents
      if (cleanUpdates.name) {
        await CollectionModel.updateMany(
          { groupId: id, userId },
          { $set: { groupName: cleanUpdates.name } }
        );

        await DocumentModel.updateMany(
          { groupId: id, userId },
          { $set: { 'taxonomy.group': cleanUpdates.name.toLowerCase() } }
        );
      }

      return updated;
    }

    const idx = this.memoryGroups.findIndex((g) => g.id === id && g.userId === userId);
    if (idx === -1) return null;

    this.memoryGroups[idx] = { ...this.memoryGroups[idx], ...cleanUpdates };

    if (cleanUpdates.name) {
      this.memoryCollections.forEach((c) => {
        if (c.groupId === id && c.userId === userId) c.groupName = cleanUpdates.name;
      });
      this.memoryDocs.forEach((d) => {
        if (d.groupId === id && d.userId === userId) {
          if (!d.taxonomy) d.taxonomy = {};
          d.taxonomy.group = cleanUpdates.name.toLowerCase();
        }
      });
    }

    return this.memoryGroups[idx];
  }

  /**
   * Delete a group (safe unassign vs cascade delete)
   */
  async deleteGroup(id, { cascade = false } = {}, userId = 'default_user') {
    if (this.isMongoConnected) {
      const group = await GroupModel.findOne({ id, userId });
      if (!group) return false;

      if (cascade) {
        // Cascade delete: delete member collections & documents
        const docs = await DocumentModel.find({ groupId: id, userId }).lean();
        for (const doc of docs) {
          if (doc.telegramMessageId) {
            try {
              await telegramService.deleteMessage(doc.telegramMessageId);
            } catch (tgErr) {
              console.warn(`Telegram deleteMessage (${doc.telegramMessageId}) warning:`, tgErr.message);
            }
          }
        }
        await DocumentModel.deleteMany({ groupId: id, userId });
        await CollectionModel.deleteMany({ groupId: id, userId });
      } else {
        // Safe disband: reset collections & documents to General
        await CollectionModel.updateMany(
          { groupId: id, userId },
          { $set: { groupId: null, groupName: 'General' } }
        );
        await DocumentModel.updateMany(
          { groupId: id, userId },
          { $set: { groupId: null, 'taxonomy.group': 'general' } }
        );
      }

      await GroupModel.deleteOne({ id, userId });
      return true;
    }

    const idx = this.memoryGroups.findIndex((g) => g.id === id && g.userId === userId);
    if (idx === -1) return false;

    if (cascade) {
      this.memoryDocs = this.memoryDocs.filter((d) => d.groupId !== id || d.userId !== userId);
      this.memoryCollections = this.memoryCollections.filter((c) => c.groupId !== id || c.userId !== userId);
    } else {
      this.memoryCollections.forEach((c) => {
        if (c.groupId === id && c.userId === userId) {
          c.groupId = null;
          c.groupName = 'General';
        }
      });
      this.memoryDocs.forEach((d) => {
        if (d.groupId === id && d.userId === userId) {
          d.groupId = null;
          if (d.taxonomy) d.taxonomy.group = 'general';
        }
      });
    }

    this.memoryGroups.splice(idx, 1);
    return true;
  }

  /**
   * Assign a target (either 'collection' or 'document') to a group
   */
  async assignToGroup({ targetType, targetId, groupId, groupName }, userId = 'default_user') {
    let resolvedGroupName = groupName;
    if (!resolvedGroupName && groupId) {
      const g = await this.getGroupById(groupId, userId);
      if (g) resolvedGroupName = g.name;
    }

    if (targetType === 'collection') {
      if (this.isMongoConnected) {
        const updated = await CollectionModel.findOneAndUpdate(
          { id: targetId, userId },
          { $set: { groupId, groupName: resolvedGroupName || 'General' } },
          { returnDocument: 'after' }
        ).lean();

        if (updated) {
          // Also sync all documents belonging to this collection
          await DocumentModel.updateMany(
            { collectionId: targetId, userId },
            { $set: { groupId, 'taxonomy.group': (resolvedGroupName || 'general').toLowerCase() } }
          );
        }
        return updated;
      }

      const col = this.memoryCollections.find((c) => c.id === targetId && c.userId === userId);
      if (col) {
        col.groupId = groupId;
        col.groupName = resolvedGroupName || 'General';
        this.memoryDocs.forEach((d) => {
          if (d.collectionId === targetId && d.userId === userId) {
            d.groupId = groupId;
            if (!d.taxonomy) d.taxonomy = {};
            d.taxonomy.group = (resolvedGroupName || 'general').toLowerCase();
          }
        });
      }
      return col;
    }

    if (targetType === 'document') {
      if (this.isMongoConnected) {
        const updated = await DocumentModel.findOneAndUpdate(
          { id: targetId, userId },
          { $set: { groupId, 'taxonomy.group': (resolvedGroupName || 'general').toLowerCase() } },
          { returnDocument: 'after' }
        ).lean();
        return updated;
      }

      const doc = this.memoryDocs.find((d) => d.id === targetId && d.userId === userId);
      if (doc) {
        doc.groupId = groupId;
        if (!doc.taxonomy) doc.taxonomy = {};
        doc.taxonomy.group = (resolvedGroupName || 'general').toLowerCase();
      }
      return doc;
    }

    throw new Error(`Invalid targetType '${targetType}'. Must be 'collection' or 'document'.`);
  }

  /**
   * Batch assign multiple items (collections or documents) to a group
   */
  async batchAssignToGroup({ targetType, targetIds, groupId, groupName }, userId = 'default_user') {
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return { modifiedCount: 0 };
    }

    let resolvedGroupName = groupName;
    if (!resolvedGroupName && groupId) {
      const g = await this.getGroupById(groupId, userId);
      if (g) resolvedGroupName = g.name;
    }

    if (targetType === 'collection') {
      if (this.isMongoConnected) {
        const res = await CollectionModel.updateMany(
          { id: { $in: targetIds }, userId },
          { $set: { groupId, groupName: resolvedGroupName || 'General' } }
        );

        // Cascade to files inside these collections
        await DocumentModel.updateMany(
          { collectionId: { $in: targetIds }, userId },
          { $set: { groupId, 'taxonomy.group': (resolvedGroupName || 'general').toLowerCase() } }
        );

        return { modifiedCount: res.modifiedCount, groupName: resolvedGroupName };
      }

      let count = 0;
      this.memoryCollections.forEach((c) => {
        if (targetIds.includes(c.id) && c.userId === userId) {
          c.groupId = groupId;
          c.groupName = resolvedGroupName || 'General';
          count++;
        }
      });
      return { modifiedCount: count, groupName: resolvedGroupName };
    }

    if (targetType === 'document') {
      if (this.isMongoConnected) {
        const res = await DocumentModel.updateMany(
          { id: { $in: targetIds }, userId },
          { $set: { groupId, 'taxonomy.group': (resolvedGroupName || 'general').toLowerCase() } }
        );
        return { modifiedCount: res.modifiedCount, groupName: resolvedGroupName };
      }

      let count = 0;
      this.memoryDocs.forEach((d) => {
        if (targetIds.includes(d.id) && d.userId === userId) {
          d.groupId = groupId;
          if (!d.taxonomy) d.taxonomy = {};
          d.taxonomy.group = (resolvedGroupName || 'general').toLowerCase();
          count++;
        }
      });
      return { modifiedCount: count, groupName: resolvedGroupName };
    }

    throw new Error(`Invalid targetType '${targetType}'. Must be 'collection' or 'document'.`);
  }
}

module.exports = new IndexManager();
