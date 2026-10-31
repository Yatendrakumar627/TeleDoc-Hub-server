const mongoose = require('mongoose');

const CollectionSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
    },
    userId: {
      type: String,
      required: true,
      default: 'default_user',
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    groupId: {
      type: String,
      default: null,
    },
    groupName: {
      type: String,
      default: 'General',
    },
    scope: {
      type: String,
      enum: ['personal', 'professional'],
      default: 'professional',
    },
    color: {
      type: String,
      default: '#0284c7',
    },
    description: {
      type: String,
      default: '',
    },
    securityLevel: {
      type: String,
      enum: ['public', 'internal', 'confidential', 'strictly_confidential'],
      default: 'confidential',
    },
    order: {
      type: Number,
      default: 0,
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

// Ultra-lean compound indexes
CollectionSchema.index({ userId: 1, scope: 1, createdAt: -1 });
CollectionSchema.index({ userId: 1, groupId: 1 });

module.exports = mongoose.model('Collection', CollectionSchema);
