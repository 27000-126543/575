const mongoose = require('mongoose');
const { NOTIFICATION_TYPE } = require('../config/constants');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: Object.values(NOTIFICATION_TYPE),
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  content: {
    type: String,
    required: true,
    trim: true,
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
  readAt: {
    type: Date,
  },
  isPushed: {
    type: Boolean,
    default: false,
  },
  pushedAt: {
    type: Date,
  },
  pushStatus: {
    type: String,
    enum: ['pending', 'sent', 'failed'],
    default: 'pending',
  },
  pushError: {
    type: String,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RentalOrder',
  },
  damageReport: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DamageReport',
  },
  report: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DailyReport',
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
  },
  level: {
    type: String,
    enum: ['info', 'warning', 'error', 'success'],
    default: 'info',
  },
}, {
  timestamps: true,
});

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, createdAt: -1 });

notificationSchema.statics.markAllAsRead = async function (userId) {
  return this.updateMany(
    { recipient: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
};

notificationSchema.statics.getUnreadCount = async function (userId) {
  return this.countDocuments({ recipient: userId, isRead: false });
};

module.exports = mongoose.model('Notification', notificationSchema);
