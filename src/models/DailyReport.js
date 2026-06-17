const mongoose = require('mongoose');

const categoryStatSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
  },
  totalTools: {
    type: Number,
    default: 0,
  },
  rentalCount: {
    type: Number,
    default: 0,
  },
  returnedCount: {
    type: Number,
    default: 0,
  },
  damageCount: {
    type: Number,
    default: 0,
  },
  revenue: {
    type: Number,
    default: 0,
  },
  overdueCount: {
    type: Number,
    default: 0,
  },
  turnoverRate: {
    type: Number,
    default: 0,
  },
  damageRate: {
    type: Number,
    default: 0,
  },
}, { _id: false });

const regionStatSchema = new mongoose.Schema({
  region: {
    type: String,
    required: true,
  },
  rentalCount: {
    type: Number,
    default: 0,
  },
  revenue: {
    type: Number,
    default: 0,
  },
  activeUsers: {
    type: Number,
    default: 0,
  },
  damageCount: {
    type: Number,
    default: 0,
  },
}, { _id: false });

const dailyReportSchema = new mongoose.Schema({
  reportDate: {
    type: Date,
    required: true,
    unique: true,
    index: true,
  },
  totalOrders: {
    type: Number,
    default: 0,
  },
  completedOrders: {
    type: Number,
    default: 0,
  },
  pendingOrders: {
    type: Number,
    default: 0,
  },
  activeRentals: {
    type: Number,
    default: 0,
  },
  overdueOrders: {
    type: Number,
    default: 0,
  },
  newUsers: {
    type: Number,
    default: 0,
  },
  activeUsers: {
    type: Number,
    default: 0,
  },
  totalRevenue: {
    type: Number,
    default: 0,
  },
  rentalRevenue: {
    type: Number,
    default: 0,
  },
  overdueRevenue: {
    type: Number,
    default: 0,
  },
  compensationRevenue: {
    type: Number,
    default: 0,
  },
  depositRefunds: {
    type: Number,
    default: 0,
  },
  totalDamageReports: {
    type: Number,
    default: 0,
  },
  pendingDamageReports: {
    type: Number,
    default: 0,
  },
  approvedDamageReports: {
    type: Number,
    default: 0,
  },
  restrictedUsers: {
    type: Number,
    default: 0,
  },
  creditScoreDrops: {
    type: Number,
    default: 0,
  },
  categoryStats: [categoryStatSchema],
  regionStats: [regionStatSchema],
  totalToolUsageHours: {
    type: Number,
    default: 0,
  },
  avgRentalDurationHours: {
    type: Number,
    default: 0,
  },
  avgOrderValue: {
    type: Number,
    default: 0,
  },
  overallTurnoverRate: {
    type: Number,
    default: 0,
  },
  overallDamageRate: {
    type: Number,
    default: 0,
  },
  generatedAt: {
    type: Date,
    default: Date.now,
  },
  isGenerated: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

dailyReportSchema.methods.recalculateRates = function () {
  const totalRentalCount = this.categoryStats.reduce((s, c) => s + c.rentalCount, 0);
  const totalDamageCount = this.categoryStats.reduce((s, c) => s + c.damageCount, 0);

  this.categoryStats.forEach(cat => {
    cat.turnoverRate = totalRentalCount > 0 ? parseFloat(((cat.rentalCount / totalRentalCount) * 100).toFixed(2)) : 0;
    cat.damageRate = cat.returnedCount > 0 ? parseFloat(((cat.damageCount / cat.returnedCount) * 100).toFixed(2)) : 0;
  });

  this.overallTurnoverRate = totalRentalCount > 0 ? 100 : 0;
  const totalReturned = this.categoryStats.reduce((s, c) => s + c.returnedCount, 0);
  this.overallDamageRate = totalReturned > 0 ? parseFloat(((totalDamageCount / totalReturned) * 100).toFixed(2)) : 0;

  if (this.completedOrders > 0) {
    this.avgRentalDurationHours = parseFloat((this.totalToolUsageHours / this.completedOrders).toFixed(2));
    this.avgOrderValue = parseFloat((this.totalRevenue / this.completedOrders).toFixed(2));
  }
};

dailyReportSchema.index({ reportDate: -1 });

module.exports = mongoose.model('DailyReport', dailyReportSchema);
