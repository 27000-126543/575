const mongoose = require('mongoose');
const { TRANSACTION_TYPE } = require('../config/constants');

const transactionSchema = new mongoose.Schema({
  transactionNo: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: Object.values(TRANSACTION_TYPE),
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  direction: {
    type: String,
    enum: ['in', 'out', 'freeze', 'unfreeze'],
    required: true,
  },
  balanceBefore: {
    type: Number,
    default: 0,
  },
  balanceAfter: {
    type: Number,
    default: 0,
  },
  frozenBefore: {
    type: Number,
    default: 0,
  },
  frozenAfter: {
    type: Number,
    default: 0,
  },
  fromFrozen: {
    type: Number,
    default: 0,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RentalOrder',
    index: true,
  },
  damageReport: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DamageReport',
    index: true,
  },
  description: {
    type: String,
    trim: true,
  },
  operator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
