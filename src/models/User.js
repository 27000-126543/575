const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_ROLE, REGION } = require('../config/constants');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, '用户名必填'],
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 50,
  },
  password: {
    type: String,
    required: [true, '密码必填'],
    minlength: 6,
    select: false,
  },
  realName: {
    type: String,
    required: [true, '真实姓名必填'],
    trim: true,
  },
  phone: {
    type: String,
    required: [true, '手机号必填'],
    unique: true,
    match: [/^1[3-9]\d{9}$/, '请输入有效的手机号'],
  },
  email: {
    type: String,
    match: [/^\S+@\S+\.\S+$/, '请输入有效的邮箱地址'],
  },
  region: {
    type: String,
    required: [true, '请选择所在区域'],
    enum: REGION,
  },
  address: {
    type: String,
    trim: true,
  },
  role: {
    type: String,
    enum: Object.values(USER_ROLE),
    default: USER_ROLE.USER,
  },
  creditScore: {
    type: Number,
    default: parseInt(process.env.DEFAULT_CREDIT_SCORE) || 100,
    min: 0,
    max: 100,
  },
  depositBalance: {
    type: Number,
    default: 0,
    min: 0,
  },
  consecutiveOverdue: {
    type: Number,
    default: 0,
    min: 0,
  },
  isRentalRestricted: {
    type: Boolean,
    default: false,
  },
  restrictionEndDate: {
    type: Date,
  },
  avatar: {
    type: String,
  },
  status: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.updateCreditScore = async function (delta, reason) {
  const oldScore = this.creditScore;
  this.creditScore = Math.max(0, Math.min(100, this.creditScore + delta));
  
  if (this.creditScore < parseInt(process.env.MIN_CREDIT_SCORE) || 60) {
    this.isRentalRestricted = true;
  }
  
  await this.save();
  return { oldScore, newScore: this.creditScore, delta, reason };
};

userSchema.methods.recordOverdue = async function () {
  this.consecutiveOverdue += 1;
  await this.updateCreditScore(-10, '逾期归还');
  
  const limit = parseInt(process.env.OVERDUE_CONSECUTIVE_LIMIT) || 2;
  if (this.consecutiveOverdue >= limit) {
    this.isRentalRestricted = true;
    this.restrictionEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }
  
  await this.save();
  return this.isRentalRestricted;
};

userSchema.methods.clearOverdueStreak = async function () {
  this.consecutiveOverdue = 0;
  await this.save();
};

userSchema.methods.canRent = function (requiredDeposit = 0) {
  if (this.isRentalRestricted) {
    if (this.restrictionEndDate && new Date() > this.restrictionEndDate) {
      return { allowed: true };
    }
    return { allowed: false, reason: '账户已被限制租赁，请联系客服' };
  }
  if (this.creditScore < (parseInt(process.env.MIN_CREDIT_SCORE) || 60)) {
    return { allowed: false, reason: `信用分不足（当前${this.creditScore}分，需${process.env.MIN_CREDIT_SCORE || 60}分）` };
  }
  if (this.depositBalance < requiredDeposit) {
    return { allowed: false, reason: `押金余额不足（当前¥${this.depositBalance}，需¥${requiredDeposit}）` };
  }
  return { allowed: true };
};

module.exports = mongoose.model('User', userSchema);
