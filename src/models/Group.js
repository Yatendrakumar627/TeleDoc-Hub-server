const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
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
    slug: {
      type: String,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    color: {
      type: String,
      default: '#6366f1',
    },
    icon: {
      type: String,
      default: 'FolderKanban',
    },
    scope: {
      type: String,
      enum: ['personal', 'professional', 'all'],
      default: 'all',
    },
    isSystem: {
      type: Boolean,
      default: false,
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
GroupSchema.index({ userId: 1, slug: 1 });
GroupSchema.index({ userId: 1, scope: 1 });

module.exports = mongoose.model('Group', GroupSchema);
