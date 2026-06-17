const mongoose = require('mongoose');
const { ORDER_STATUS } = require('../config/constants');

const orderSchema = new mongoose.Schema({
  orderNo: {
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
  tool: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tool',
    required: true,
    index: true,
  },
  quantity: {
    type: Number,
    default: 1,
    min: 1,
  },
  startTime: {
    type: Date,
    required: true,
    index: true,
  },
  endTime: {
    type: Date,
    required: true,
  },
  actualStartTime: {
    type: Date,
  },
  actualEndTime: {
    type: Date,
  },
  rentalFee: {
    type: Number,
    required: true,
    min: 0,
  },
  periodBreakdown: [{
    type: { type: String },
    count: { type: Number },
    unitPrice: { type: Number },
    subtotal: { type: Number },
  }],
  depositRequired: {
    type: Number,
    required: true,
    min: 0,
  },
  depositPaid: {
    type: Boolean,
    default: false,
  },
  depositFrozen: {
    type: Boolean,
    default: false,
  },
  overdueCounted: {
    type: Boolean,
    default: false,
  },
  overdueHours: {
    type: Number,
    default: 0,
    min: 0,
  },
  overdueFee: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: Object.values(ORDER_STATUS),
    default: ORDER_STATUS.PENDING,
    index: true,
  },
  rejectionReason: {
    type: String,
  },
  pickupImages: [{
    type: String,
  }],
  returnImages: [{
    type: String,
  }],
  damageDetected: {
    type: Boolean,
    default: false,
  },
  damageReport: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DamageReport',
  },
  hasBeenOverdue: {
    type: Boolean,
    default: false,
  },
  statusHistory: [{
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    operator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remark: { type: String },
  }],
  notes: {
    type: String,
    trim: true,
  },
  remindersSent: {
    type: Number,
    default: 0,
  },
  lastReminderAt: {
    type: Date,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

orderSchema.pre('save', function (next) {
  if (this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      remark: '订单创建',
    });
  }
  next();
});

orderSchema.methods.updateStatus = async function (newStatus, operatorId, remark = '') {
  this.status = newStatus;
  this.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
    operator: operatorId || null,
    remark,
  });
  return this.save();
};

orderSchema.methods.calculateOverdue = async function (tool, currentDate = new Date()) {
  if (this.status !== ORDER_STATUS.PICKED_UP && this.status !== ORDER_STATUS.OVERDUE) {
    return { overdue: false };
  }

  const baseEndTime = new Date(this.endTime);
  if (currentDate <= baseEndTime) {
    return { overdue: false };
  }

  const diffMs = currentDate - baseEndTime;
  const newOverdueHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const newOverdueFee = tool.calculateOverdueFee(newOverdueHours);

  const changed = newOverdueHours !== this.overdueHours || newOverdueFee !== this.overdueFee;

  this.overdueHours = newOverdueHours;
  this.overdueFee = newOverdueFee;
  this.hasBeenOverdue = true;
  this.status = ORDER_STATUS.OVERDUE;
  this.totalAmount = this.rentalFee + this.overdueFee;

  if (changed) {
    this.statusHistory.push({
      status: ORDER_STATUS.OVERDUE,
      timestamp: new Date(),
      remark: `逾期${newOverdueHours}小时，逾期费用¥${newOverdueFee}`,
    });
  }

  await this.save();

  return {
    overdue: true,
    overdueHours: newOverdueHours,
    overdueFee: newOverdueFee,
    changed,
  };
};

orderSchema.methods.markPickedUp = async function () {
  this.actualStartTime = new Date();
  await this.updateStatus(ORDER_STATUS.PICKED_UP, null, '用户已取用工具，开始计时');
  return this;
};

orderSchema.methods.markReturned = async function (returnImages = []) {
  this.actualEndTime = new Date();
  this.returnImages = returnImages;

  const actualStart = this.actualStartTime || this.startTime;
  const actualEnd = this.actualEndTime;
  const scheduledEnd = this.endTime;

  const tool = this.tool instanceof mongoose.Document ? this.tool : null;
  if (tool && actualEnd > scheduledEnd) {
    const diffMs = actualEnd - scheduledEnd;
    const hours = Math.ceil(diffMs / (1000 * 60 * 60));
    const fee = tool.calculateOverdueFee(hours);
    this.overdueHours = hours;
    this.overdueFee = fee;
    this.hasBeenOverdue = true;
    this.totalAmount = this.rentalFee + fee;
  }

  await this.updateStatus(ORDER_STATUS.RETURNED, null, '工具已归还，待检测');
  return this;
};

orderSchema.methods.complete = async function () {
  await this.updateStatus(ORDER_STATUS.COMPLETED, null, '订单完成');
  return this;
};

orderSchema.methods.reject = async function (reason) {
  this.rejectionReason = reason;
  await this.updateStatus(ORDER_STATUS.REJECTED, null, reason);
  return this;
};

orderSchema.index({ user: 1, status: 1 });
orderSchema.index({ tool: 1, status: 1 });
orderSchema.index({ startTime: 1, endTime: 1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('RentalOrder', orderSchema);
