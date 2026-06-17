const mongoose = require('mongoose');
const { User, Transaction } = require('../models');
const { TRANSACTION_TYPE } = require('../config/constants');
const { generateTransactionNo, withTransaction, sessionSave, sessionCreate } = require('../utils/helpers');
const NotificationService = require('./notificationService');
const RealtimeService = require('./realtimeService');

class TransactionService {
  static async create(userId, type, amount, direction, description = '', extra = {}, freezeOnly = false) {
    return await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      const user = useTransaction
        ? await User.findById(userId).session(session)
        : await User.findById(userId);

      if (!user) {
        throw new Error('用户不存在');
      }

      const balanceBefore = user.depositBalance;
      const frozenBefore = user.frozenDeposit || 0;
      let balanceAfter = balanceBefore;
      let frozenAfter = frozenBefore;

      if (type === TRANSACTION_TYPE.DEPOSIT_FREEZE) {
        if ((balanceBefore - frozenBefore) < amount) {
          throw new Error('可用押金不足，无法冻结');
        }
        frozenAfter = frozenBefore + amount;
      } else if (type === TRANSACTION_TYPE.DEPOSIT_UNFREEZE) {
        const unfreezeAmount = Math.min(frozenBefore, amount);
        frozenAfter = frozenBefore - unfreezeAmount;
      } else if (direction === 'in') {
        balanceAfter = balanceBefore + amount;
      } else {
        if (type === TRANSACTION_TYPE.COMPENSATION) {
          const fromFrozen = Math.min(frozenBefore, amount);
          const remaining = amount - fromFrozen;
          frozenAfter = frozenBefore - fromFrozen;
          balanceAfter = balanceBefore - remaining;
          if (balanceAfter < 0) {
            throw new Error('押金余额不足');
          }
        } else {
          if (balanceBefore < amount) {
            throw new Error('押金余额不足');
          }
          balanceAfter = balanceBefore - amount;
        }
      }

      user.depositBalance = balanceAfter;
      user.frozenDeposit = frozenAfter;
      await sessionSave(user, sessionOpt);

      const txnData = {
        transactionNo: generateTransactionNo(),
        user: userId,
        type,
        amount,
        direction,
        balanceBefore,
        balanceAfter,
        frozenBefore,
        frozenAfter,
        description,
        ...extra,
      };
      const transaction = await sessionCreate(Transaction, txnData, sessionOpt);

      return {
        transaction,
        user,
        balanceBefore,
        balanceAfter,
        frozenBefore,
        frozenAfter,
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
    RealtimeService.emitToUser(userId, {
      type: 'deposit.completed',
      payload: {
      amount,
      newBalance: result.balanceAfter,
      },
    });
    return result;
  }

  static async freezeDeposit(userId, amount, orderId = null, operatorId = null) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.DEPOSIT_FREEZE,
      amount,
      'freeze',
      '订单押金冻结',
      { order: orderId, operator: operatorId }
    );
    RealtimeService.emitToUser(userId, {
      type: 'deposit.frozen',
      payload: {
      amount,
      orderId,
      frozenDeposit: result.frozenAfter,
      },
    });
    return result;
  }

  static async unfreezeDeposit(userId, amount, orderId = null, reason = '押金释放', operatorId = null) {
    const result = await this.create(
      userId,
      TRANSACTION_TYPE.DEPOSIT_UNFREEZE,
      amount,
      'unfreeze',
      reason,
      { order: orderId, operator: operatorId }
    );
    RealtimeService.emitToUser(userId, {
      type: 'deposit.unfrozen',
      payload: {
        amount,
        orderId,
        frozenDeposit: result.frozenAfter,
        availableDeposit: result.balanceAfter - result.frozenAfter,
      },
    });
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
    RealtimeService.emitToUser(userId, {
      type: 'payment.rental.deducted',
      payload: {
      amount,
      orderId,
      balance: result.balanceAfter,
      },
    });
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
    RealtimeService.emitToUser(userId, {
      type: 'payment.overdue.deducted',
      payload: {
      amount,
      orderId,
      balance: result.balanceAfter,
      },
    });
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
    RealtimeService.emitToUser(userId, {
      type: 'payment.compensation.deducted',
      payload: {
      amount,
      orderId,
      damageReportId,
      balance: result.balanceAfter,
      },
    });
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
    RealtimeService.emitToUser(userId, {
      type: 'deposit.refunded',
      payload: {
      amount,
      orderId,
      balance: result.balanceAfter,
      },
    });
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
