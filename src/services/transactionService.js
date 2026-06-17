const mongoose = require('mongoose');
const { User, Transaction } = require('../models');
const { TRANSACTION_TYPE } = require('../config/constants');
const { generateTransactionNo, withTransaction, sessionSave, sessionCreate } = require('../utils/helpers');
const NotificationService = require('./notificationService');

class TransactionService {
  static async create(userId, type, amount, direction, description = '', extra = {}) {
    return await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      const user = useTransaction
        ? await User.findById(userId).session(session)
        : await User.findById(userId);

      if (!user) {
        throw new Error('用户不存在');
      }

      const balanceBefore = user.depositBalance;
      let balanceAfter = balanceBefore;

      if (direction === 'in') {
        balanceAfter = balanceBefore + amount;
      } else {
        if (balanceBefore < amount) {
          throw new Error('押金余额不足');
        }
        balanceAfter = balanceBefore - amount;
      }

      user.depositBalance = balanceAfter;
      await sessionSave(user, sessionOpt);

      const txnData = {
        transactionNo: generateTransactionNo(),
        user: userId,
        type,
        amount,
        direction,
        balanceBefore,
        balanceAfter,
        description,
        ...extra,
      };
      const transaction = await sessionCreate(Transaction, txnData, sessionOpt);

      return {
        transaction,
        user,
        balanceBefore,
        balanceAfter,
      };
    });
  }

  static async deposit(userId, amount, operatorId = null) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.DEPOSIT,
      amount,
      'in',
      '用户充值押金',
      { operator: operatorId }
    );
    return result;
  }

  static async deductRentalFee(userId, amount, orderId) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.RENTAL_FEE,
      amount,
      'out',
      '租赁费用扣除',
      { order: orderId }
    );
    return result;
  }

  static async deductOverdueFee(userId, amount, orderId) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.OVERDUE_FEE,
      amount,
      'out',
      '逾期费用扣除',
      { order: orderId }
    );
    return result;
  }

  static async deductCompensation(userId, amount, orderId, damageReportId, operatorId = null) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.COMPENSATION,
      amount,
      'out',
      '损坏赔偿扣除',
      {
        order: orderId,
        damageReport: damageReportId,
        operator: operatorId,
      }
    );
    return result;
  }

  static async refundDeposit(userId, amount, orderId, reason = '订单完成退还押金') {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.REFUND,
      amount,
      'in',
      reason,
      { order: orderId }
    );
    return result;
  }

  static async getHistory(userId, options = {}) {
    const { page = 1, pageSize = 20, type, startDate, endDate } = options;
    const skip = (page - 1) * pageSize;

    const filter = { user: userId };
    if (type) filter.type = type;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const [list, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Transaction.countDocuments(filter),
    ]);

    return {
      list,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getAll(options = {}) {
    const { page = 1, pageSize = 20, type, userId, startDate, endDate } = options;
    const skip = (page - 1) * pageSize;

    const filter = {};
    if (type) filter.type = type;
    if (userId) filter.user = userId;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const [list, total] = await Promise.all([
      Transaction.find(filter)
        .populate('user', 'username realName phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Transaction.countDocuments(filter),
    ]);

    return {
      list,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }
}

module.exports = TransactionService;
