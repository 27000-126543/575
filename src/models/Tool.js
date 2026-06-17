const mongoose = require('mongoose');
const { TOOL_CATEGORY, REGION } = require('../config/constants');

const pricingSchema = new mongoose.Schema({
  periodType: {
    type: String,
    enum: ['hour', 'day', 'week', 'month'],
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
}, { _id: false });

const toolSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, '工具名称必填'],
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  category: {
    type: String,
    required: [true, '工具类别必填'],
    enum: TOOL_CATEGORY,
  },
  brand: {
    type: String,
    trim: true,
  },
  model: {
    type: String,
    trim: true,
  },
  images: [{
    type: String,
  }],
  totalStock: {
    type: Number,
    required: [true, '总库存必填'],
    min: 0,
  },
  availableStock: {
    type: Number,
    min: 0,
  },
  lockedStock: {
    type: Number,
    default: 0,
    min: 0,
  },
  deposit: {
    type: Number,
    required: [true, '押金必填'],
    min: 0,
  },
  pricing: {
    type: [pricingSchema],
    required: [true, '价格配置必填'],
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: '至少需要配置一种价格方案',
    },
  },
  minRentalPeriod: {
    type: Number,
    default: 1,
    min: 1,
  },
  minRentalUnit: {
    type: String,
    enum: ['hour', 'day', 'week', 'month'],
    default: 'hour',
  },
  maxRentalDays: {
    type: Number,
    default: 30,
    min: 1,
  },
  region: {
    type: String,
    required: [true, '存放区域必填'],
    enum: REGION,
  },
  location: {
    type: String,
    trim: true,
  },
  status: {
    type: Boolean,
    default: true,
  },
  usageCount: {
    type: Number,
    default: 0,
  },
  damageCount: {
    type: Number,
    default: 0,
  },
  totalRevenue: {
    type: Number,
    default: 0,
  },
  specifications: {
    type: Map,
    of: String,
  },
  usageInstructions: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

toolSchema.pre('save', function (next) {
  if (this.availableStock === undefined || this.availableStock === null) {
    this.availableStock = this.totalStock;
  }
  if (this.availableStock > this.totalStock) {
    this.availableStock = this.totalStock;
  }
  next();
});

toolSchema.methods.calculateRent = function (startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;
  const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.ceil(diffDays / 7);
  const diffMonths = Math.ceil(diffDays / 30);

  let totalRent = 0;
  let periodBreakdown = [];
  let remainingHours = diffHours;
  let remainingDays = diffDays;

  const monthPrice = this.pricing.find(p => p.periodType === 'month');
  if (monthPrice && remainingDays >= 30) {
    const months = Math.floor(remainingDays / 30);
    totalRent += months * monthPrice.price;
    periodBreakdown.push({ type: 'month', count: months, unitPrice: monthPrice.price, subtotal: months * monthPrice.price });
    remainingDays -= months * 30;
    remainingHours = remainingDays * 24;
  }

  const weekPrice = this.pricing.find(p => p.periodType === 'week');
  if (weekPrice && remainingDays >= 7) {
    const weeks = Math.floor(remainingDays / 7);
    totalRent += weeks * weekPrice.price;
    periodBreakdown.push({ type: 'week', count: weeks, unitPrice: weekPrice.price, subtotal: weeks * weekPrice.price });
    remainingDays -= weeks * 7;
    remainingHours = remainingDays * 24;
  }

  const dayPrice = this.pricing.find(p => p.periodType === 'day');
  if (dayPrice && remainingDays >= 1) {
    totalRent += remainingDays * dayPrice.price;
    periodBreakdown.push({ type: 'day', count: remainingDays, unitPrice: dayPrice.price, subtotal: remainingDays * dayPrice.price });
    remainingHours = 0;
  }

  const hourPrice = this.pricing.find(p => p.periodType === 'hour');
  if (hourPrice && remainingHours > 0) {
    totalRent += remainingHours * hourPrice.price;
    periodBreakdown.push({ type: 'hour', count: remainingHours, unitPrice: hourPrice.price, subtotal: remainingHours * hourPrice.price });
  }

  const pricingMap = {};
  this.pricing.forEach(p => { pricingMap[p.periodType] = p.price; });
  if (periodBreakdown.length === 0 && diffHours > 0) {
    if (pricingMap.day) {
      const days = Math.max(1, Math.ceil(diffHours / 24));
      totalRent = days * pricingMap.day;
      periodBreakdown.push({ type: 'day', count: days, unitPrice: pricingMap.day, subtotal: totalRent });
    } else if (pricingMap.hour) {
      totalRent = diffHours * pricingMap.hour;
      periodBreakdown.push({ type: 'hour', count: diffHours, unitPrice: pricingMap.hour, subtotal: totalRent });
    } else if (pricingMap.week) {
      const weeks = Math.max(1, Math.ceil(diffDays / 7));
      totalRent = weeks * pricingMap.week;
      periodBreakdown.push({ type: 'week', count: weeks, unitPrice: pricingMap.week, subtotal: totalRent });
    } else if (pricingMap.month) {
      const months = Math.max(1, Math.ceil(diffDays / 30));
      totalRent = months * pricingMap.month;
      periodBreakdown.push({ type: 'month', count: months, unitPrice: pricingMap.month, subtotal: totalRent });
    }
  }

  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));

  return {
    totalRent,
    periodBreakdown,
    duration: {
      hours: diffHours,
      days: diffDays,
      weeks: diffWeeks,
      months: diffMonths,
      totalHours,
    },
  };
};

toolSchema.methods.calculateOverdueFee = function (overdueHours) {
  const hourPrice = this.pricing.find(p => p.periodType === 'hour');
  const basePrice = hourPrice ? hourPrice.price : 0;
  const penaltyRate = 1.5;
  return Math.ceil(overdueHours * basePrice * penaltyRate);
};

toolSchema.methods.lockStock = async function (quantity = 1) {
  if (this.availableStock < quantity) {
    throw new Error('库存不足');
  }
  this.availableStock -= quantity;
  this.lockedStock += quantity;
  return this.save();
};

toolSchema.methods.unlockStock = async function (quantity = 1) {
  const unlockQty = Math.min(quantity, this.lockedStock);
  this.lockedStock -= unlockQty;
  this.availableStock += unlockQty;
  return this.save();
};

toolSchema.methods.pickUp = async function (quantity = 1) {
  const pickQty = Math.min(quantity, this.lockedStock);
  this.lockedStock -= pickQty;
  this.usageCount += pickQty;
  return this.save();
};

toolSchema.methods.returnStock = async function (quantity = 1) {
  this.availableStock += quantity;
  return this.save();
};

toolSchema.methods.recordDamage = async function () {
  this.damageCount += 1;
  return this.save();
};

toolSchema.methods.addRevenue = async function (amount) {
  this.totalRevenue += amount;
  return this.save();
};

toolSchema.index({ category: 1 });
toolSchema.index({ region: 1 });
toolSchema.index({ status: 1 });
toolSchema.index({ availableStock: 1 });

module.exports = mongoose.model('Tool', toolSchema);
