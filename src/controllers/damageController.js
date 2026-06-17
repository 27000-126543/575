const mongoose = require('mongoose');
const { DamageReport, RentalOrder, Tool, User } = require('../models');
const {
  successResponse, paginatedResponse,
  BadRequestError, NotFoundError, ForbiddenError,
} = require('../utils/response');
const {
  getPaginationParams, asyncHandler,
  withTransaction, sessionSave, sessionCreate,
} = require('../utils/helpers');
const { DAMAGE_STATUS, USER_ROLE, ORDER_STATUS } = require('../config/constants');
const TransactionService = require('../services/transactionService');
const NotificationService = require('../services/notificationService');
const RealtimeService = require('../services/realtimeService');

const damageController = {
  list: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = {};

    if (req.user.role !== USER_ROLE.ADMIN) {
      filter.user = req.userId;
    } else if (req.query.userId) {
      filter.user = req.query.userId;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.severity) {
      filter['damages.severity'] = req.query.severity;
    }
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
    }

    const [reports, total] = await Promise.all([
      DamageReport.find(filter)
        .populate('tool', 'name category images')
        .populate('order', 'orderNo startTime endTime')
        .populate('user', 'username realName phone')
        .populate('reviewedBy', 'username realName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      DamageReport.countDocuments(filter),
    ]);

    paginatedResponse(res, reports, total, page, pageSize);
  }),

  getById: asyncHandler(async (req, res) => {
    const report = await DamageReport.findById(req.params.id)
      .populate('tool')
      .populate('order')
      .populate('user', 'username realName phone region')
      .populate('reviewedBy', 'username realName')
      .populate('compensationTransaction');

    if (!report) {
      throw new NotFoundError('损坏工单不存在');
    }

    if (req.user.role !== USER_ROLE.ADMIN && report.user._id.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权查看此工单');
    }

    successResponse(res, report);
  }),

  review: asyncHandler(async (req, res) => {
    const { approve, compensationAmount, notes = '' } = req.body;

    if (approve === undefined || typeof approve !== 'boolean') {
      throw new BadRequestError('请指定审核结果（approve）');
    }

    const report = await DamageReport.findById(req.params.id);
    if (!report) {
      throw new NotFoundError('损坏工单不存在');
    }

    if (![DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW, DAMAGE_STATUS.ESCALATED, DAMAGE_STATUS.PENDING_PAYMENT, DAMAGE_STATUS.PAYMENT_FAILED].includes(report.status)) {
      throw new BadRequestError(`当前工单状态不允许审核（状态：${report.status}）`);
    }

    let paymentInfo = { paid: false, failed: false, message: '' };

    await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      if (approve) {
        await report.approve(req.userId, compensationAmount, notes);

        try {
          const txnResult = await TransactionService.deductCompensation(
            report.user,
            report.totalCompensation,
            report.order,
            report._id,
            req.userId
          );
          await report.markCompensated(txnResult.transaction._id);
          paymentInfo = { paid: true, failed: false, message: '赔偿扣款成功', transactionId: txnResult.transaction._id };
        } catch (txnError) {
          console.warn('赔偿扣款失败，保留待支付状态:', txnError.message);
          await report.markPaymentFailed(txnError.message || '扣款失败', req.userId);
          paymentInfo = {
            paid: false,
            failed: true,
            message: `赔偿扣款失败：${txnError.message}，用户需补足余额后重试`,
            error: txnError.message,
          };
        }

        try {
          const user = useTransaction ? await User.findById(report.user).session(session) : await User.findById(report.user);
          if (user) {
            const creditResult = await user.updateCreditScore(-15, '损坏物品赔偿');
            await NotificationService.creditUpdate(
              user._id,
              creditResult.delta,
              creditResult.newScore,
              creditResult.reason
            );
          }
        } catch (creditError) {
          console.warn('信用分扣除失败:', creditError.message);
        }

        try {
          const order = useTransaction ? await RentalOrder.findById(report.order).session(session) : await RentalOrder.findById(report.order);
          if (order) {
            order.damageDetected = true;
            order.damageReport = report._id;
            if (order.status !== ORDER_STATUS.COMPLETED && paymentInfo.paid) {
              await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, '损坏赔偿处理完成，订单结束');
            }
            await sessionSave(order, sessionOpt);
          }
        } catch (orderError) {
          console.warn('订单状态更新失败:', orderError.message);
        }

        if (paymentInfo.paid) {
          try {
            await TransactionService.unfreezeDeposit(
              report.user,
              0,
              report.order,
              '损坏赔偿已完成'
            );
          } catch (e) {}
        }

        await NotificationService.damageReviewed(report, true, notes);
        RealtimeService.broadcastDamageEvent(report, 'reviewed', {
          approved: true,
          totalCompensation: report.totalCompensation,
          payment: paymentInfo,
        });

        if (paymentInfo.failed) {
          await NotificationService.compensationFailed(report, paymentInfo.error, paymentInfo.message);
          RealtimeService.broadcastDamageEvent(report, 'payment_failed', {
            error: paymentInfo.error,
            totalCompensation: report.totalCompensation,
          });
        } else if (paymentInfo.paid) {
          RealtimeService.broadcastDamageEvent(report, 'compensated', {
            transactionId: paymentInfo.transactionId,
          });
        }
      } else {
        await report.reject(req.userId, notes);

        try {
          const order = useTransaction ? await RentalOrder.findById(report.order).session(session) : await RentalOrder.findById(report.order);
          if (order && order.status !== ORDER_STATUS.COMPLETED) {
            order.damageDetected = false;
            await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, '审核无损坏，订单完成');
          }
          if (order && order.depositFrozen && order.depositRequired > 0) {
            await TransactionService.unfreezeDeposit(
              report.user,
              order.depositRequired,
              report.order,
              '审核无损坏，释放冻结押金'
            );
          }
        } catch (e) {
          console.warn('押金释放失败:', e.message);
        }

        await NotificationService.damageReviewed(report, false, notes);
        RealtimeService.broadcastDamageEvent(report, 'reviewed', { approved: false });
      }
    });

    const updated = await DamageReport.findById(req.params.id)
      .populate('compensationTransaction');

    let message;
    if (approve) {
      if (paymentInfo.paid) {
        message = `审核通过，赔偿金额¥${report.totalCompensation}已处理`;
      } else {
        message = `审核通过，但赔偿扣款失败（${paymentInfo.error}）。状态已保留为${updated.status}，用户补足余额后可继续完成赔偿`;
      }
    } else {
      message = '审核拒绝，无需赔偿';
    }

    successResponse(res, {
      report: updated,
      approved: approve,
      payment: paymentInfo,
      message,
    }, message, paymentInfo.failed ? 202 : 200);
  }),

  pay: asyncHandler(async (req, res) => {
    const report = await DamageReport.findById(req.params.id);
    if (!report) {
      throw new NotFoundError('损坏工单不存在');
    }
    if (report.status !== DAMAGE_STATUS.PENDING_PAYMENT && report.status !== DAMAGE_STATUS.PAYMENT_FAILED) {
      throw new BadRequestError(`当前工单状态不允许支付（状态：${report.status}）`);
    }
    if (req.user.role !== USER_ROLE.ADMIN && report.user.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权操作此工单');
    }

    let paymentInfo = { paid: false, failed: false, message: '' };

    try {
      await report.markPendingPayment(req.userId, '用户/管理员主动发起赔偿扣款');
      const txnResult = await TransactionService.deductCompensation(
        report.user,
        report.totalCompensation,
        report.order,
        report._id,
        req.userId
      );
      await report.markCompensated(txnResult.transaction._id);
      paymentInfo = { paid: true, failed: false, message: '赔偿扣款成功', transactionId: txnResult.transaction._id };

      const { RentalOrder } = require('../models');
      const order = await RentalOrder.findById(report.order);
      if (order && order.status !== ORDER_STATUS.COMPLETED) {
        await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, '赔偿扣款完成，订单结束');
      }

      await NotificationService.payment(report, report.totalCompensation, '赔偿已完成扣款');
      RealtimeService.broadcastDamageEvent(report, 'compensated', {
        transactionId: txnResult.transaction._id,
      });
    } catch (txnError) {
      console.warn('赔偿扣款重试失败:', txnError.message);
      await report.markPaymentFailed(txnError.message || '扣款失败', req.userId);
      paymentInfo = {
        paid: false,
        failed: true,
        message: `赔偿扣款失败：${txnError.message}，请补足余额后重试`,
        error: txnError.message,
      };
      await NotificationService.compensationFailed(report, txnError.message, paymentInfo.message);
      RealtimeService.broadcastDamageEvent(report, 'payment_failed', {
        error: txnError.message,
        totalCompensation: report.totalCompensation,
      });
    }

    const updated = await DamageReport.findById(req.params.id)
      .populate('compensationTransaction');

    successResponse(res, {
      report: updated,
      payment: paymentInfo,
      message: paymentInfo.message,
    }, paymentInfo.message, paymentInfo.failed ? 202 : 200);
  }),

  updateCompensation: asyncHandler(async (req, res) => {
    const { totalCompensation, notes = '' } = req.body;

    if (totalCompensation === undefined || totalCompensation < 0) {
      throw new BadRequestError('请输入有效的赔偿金额');
    }

    const report = await DamageReport.findById(req.params.id);
    if (!report) {
      throw new NotFoundError('损坏工单不存在');
    }
    if (report.status === DAMAGE_STATUS.COMPENSATED) {
      throw new BadRequestError('赔偿已完成，无法修改');
    }

    report.totalCompensation = totalCompensation;
    report.adminCompensationAdjustment = totalCompensation;
    report.adminNotes = notes || report.adminNotes;
    await report.save();

    successResponse(res, { report }, `赔偿金额已调整为¥${totalCompensation}`);
  }),

  startReview: asyncHandler(async (req, res) => {
    const report = await DamageReport.findById(req.params.id);
    if (!report) {
      throw new NotFoundError('损坏工单不存在');
    }
    if (report.status !== DAMAGE_STATUS.PENDING && report.status !== DAMAGE_STATUS.ESCALATED) {
      throw new BadRequestError(`当前状态不允许开始审核（状态：${report.status}）`);
    }

    report.assignedAdmin = req.userId;
    await report.updateStatus(DAMAGE_STATUS.UNDER_REVIEW, req.userId, '开始审核');

    successResponse(res, { report }, '已开始审核');
  }),

  getStatistics: asyncHandler(async (req, res) => {
    const pipeline = [
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalCompensation: { $sum: '$totalCompensation' },
        },
      },
    ];

    const byStatus = await DamageReport.aggregate(pipeline);
    const totalReports = byStatus.reduce((s, g) => s + g.count, 0);
    const totalCompensation = byStatus.reduce((s, g) => s + g.totalCompensation, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayReports = await DamageReport.countDocuments({ createdAt: { $gte: today } });

    const pendingCount = await DamageReport.countDocuments({
      status: { $in: [DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW, DAMAGE_STATUS.ESCALATED] },
    });

    successResponse(res, {
      totalReports,
      totalCompensation,
      todayReports,
      pendingCount,
      byStatus,
    });
  }),

  getOverdueReports: asyncHandler(async (req, res) => {
    const timeoutMs = (parseInt(process.env.ADMIN_AUDIT_TIMEOUT_HOURS) || 2) * 60 * 60 * 1000;
    const deadline = new Date(Date.now() - timeoutMs);

    const reports = await DamageReport.find({
      status: { $in: [DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW] },
      createdAt: { $lte: deadline },
    })
      .populate('tool', 'name category')
      .populate('user', 'username realName phone')
      .populate('order', 'orderNo')
      .sort({ createdAt: 1 });

    successResponse(res, {
      count: reports.length,
      timeoutHours: process.env.ADMIN_AUDIT_TIMEOUT_HOURS || 2,
      reports,
    });
  }),
};

module.exports = damageController;
