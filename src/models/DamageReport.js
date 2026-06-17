const mongoose = require('mongoose');
const { DAMAGE_STATUS } = require('../config/constants');

const damageItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true,
    trim: true,
  },
  severity: {
    type: String,
    enum: ['minor', 'moderate', 'severe'],
    default: 'minor',
  },
  location: {
    type: String,
    trim: true,
  },
  estimatedCost: {
    type: Number,
    min: 0,
  },
}, { _id: false });

const damageReportSchema = new mongoose.Schema({
  reportNo: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RentalOrder',
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
  tool: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tool',
    required: true,
  },
  damages: [damageItemSchema],
  pickupImages: [{
    type: String,
  }],
  returnImages: [{
    type: String,
  }],
  comparisonResult: {
    confidence: {
      type: Number,
      min: 0,
      max: 100,
    },
    damageFound: {
      type: Boolean,
      default: false,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  totalCompensation: {
    type: Number,
    default: 0,
    min: 0,
  },
  adminCompensationAdjustment: {
    type: Number,
    min: 0,
  },
  status: {
    type: String,
    enum: Object.values(DAMAGE_STATUS),
    default: DAMAGE_STATUS.PENDING,
    index: true,
  },
  assignedAdmin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
  adminNotes: {
    type: String,
    trim: true,
  },
  compensatedAt: {
    type: Date,
  },
  compensationTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
  },
  paymentFailedReason: {
    type: String,
    trim: true,
  },
  lastPaymentAttemptAt: {
    type: Date,
  },
  paymentAttempts: {
    type: Number,
    default: 0,
    min: 0,
  },
  remindersSent: {
    type: Number,
    default: 0,
  },
  lastReminderAt: {
    type: Date,
  },
  escalationLevel: {
    type: Number,
    default: 0,
    min: 0,
  },
  statusHistory: [{
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    operator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remark: { type: String },
  }],
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

damageReportSchema.pre('save', function (next) {
  if (this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      remark: '损坏报告创建',
    });
  }
  if (!this.totalCompensation) {
    this.totalCompensation = this.damages.reduce((sum, d) => sum + (d.estimatedCost || 0), 0);
  }
  next();
});

damageReportSchema.methods.updateStatus = async function (newStatus, operatorId, remark = '') {
  this.status = newStatus;
  const historyEntry = {
    status: newStatus,
    timestamp: new Date(),
    remark,
  };
  if (operatorId) {
    historyEntry.operator = operatorId;
    if (newStatus === DAMAGE_STATUS.APPROVED || newStatus === DAMAGE_STATUS.REJECTED) {
      this.reviewedBy = operatorId;
      this.reviewedAt = new Date();
    }
  }
  this.statusHistory.push(historyEntry);
  return this.save();
};

damageReportSchema.methods.isOverdue = function () {
  const timeoutHours = parseInt(process.env.ADMIN_AUDIT_TIMEOUT_HOURS) || 2;
  const deadline = new Date(this.createdAt.getTime() + timeoutHours * 60 * 60 * 1000);
  return (this.status === DAMAGE_STATUS.PENDING || this.status === DAMAGE_STATUS.UNDER_REVIEW) && new Date() > deadline;
};

damageReportSchema.methods.escalate = async function (maxLevel = 3) {
  if (this.escalationLevel < maxLevel) {
    this.escalationLevel += 1;
    this.status = DAMAGE_STATUS.ESCALATED;
    this.statusHistory.push({
      status: DAMAGE_STATUS.ESCALATED,
      timestamp: new Date(),
      remark: `升级至级别${this.escalationLevel}：管理员审核超时`,
    });
    await this.save();
    return true;
  }
  return false;
};

damageReportSchema.methods.approve = async function (adminId, compensationAmount, notes = '') {
  if (compensationAmount !== undefined && compensationAmount !== null) {
    this.adminCompensationAdjustment = compensationAmount;
    this.totalCompensation = compensationAmount;
  }
  this.adminNotes = notes;
  await this.updateStatus(DAMAGE_STATUS.APPROVED, adminId, `审核通过，赔偿金额¥${this.totalCompensation}`);
  return this;
};

damageReportSchema.methods.reject = async function (adminId, notes = '') {
  this.adminNotes = notes;
  this.totalCompensation = 0;
  await this.updateStatus(DAMAGE_STATUS.REJECTED, adminId, '审核拒绝，无损坏或无需赔偿');
  return this;
};

damageReportSchema.methods.markCompensated = async function (transactionId) {
  this.compensatedAt = new Date();
  this.compensationTransaction = transactionId;
  await this.updateStatus(DAMAGE_STATUS.COMPENSATED, null, '赔偿已完成扣款');
  return this;
};

damageReportSchema.methods.markPendingPayment = async function (operatorId = null, remark = '等待支付赔偿') {
  this.lastPaymentAttemptAt = new Date();
  this.paymentAttempts = (this.paymentAttempts || 0) + 1;
  await this.updateStatus(DAMAGE_STATUS.PENDING_PAYMENT, operatorId, remark);
  return this;
};

damageReportSchema.methods.markPaymentFailed = async function (reason, operatorId = null) {
  this.paymentFailedReason = reason || '扣款失败';
  this.lastPaymentAttemptAt = new Date();
  this.paymentAttempts = (this.paymentAttempts || 0) + 1;
  await this.updateStatus(DAMAGE_STATUS.PAYMENT_FAILED, operatorId, `赔偿扣款失败：${reason || '未知原因'}`);
  return this;
};

damageReportSchema.methods.retryCompensation = async function () {
  return this.markPendingPayment(null, '用户补足余额，重试赔偿扣款');
};

damageReportSchema.index({ status: 1, createdAt: 1 });
damageReportSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('DamageReport', damageReportSchema);
