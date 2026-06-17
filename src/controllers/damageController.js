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

    if (![DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW, DAMAGE_STATUS.ESCALATED].includes(report.status)) {
      throw new BadRequestError(`当前工单状态不允许审核（状态：${report.status}）`);
    }

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
        } catch (txnError) {
          console.warn('赔偿扣款失败:', txnError.message);
        }

        try {
          const user = useTransaction ? await User.findById(report.user).session(session) : await User.findById(report.user);
          const creditResult = await user.updateCreditScore(-15, '损坏物品赔偿');
          await NotificationService.creditUpdate(
            user._id,
            creditResult.delta,
            creditResult.newScore,
            creditResult.reason
          );
        } catch (creditError) {
          console.warn('信用分扣除失败:', creditError.message);
        }

        try {
          const order = useTransaction ? await RentalOrder.findById(report.order).session(session) : await RentalOrder.findById(report.order);
          if (order) {
            order.damageDetected = true;
            order.damageReport = report._id;
            if (order.status !== ORDER_STATUS.COMPLETED) {
              await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, '损坏赔偿处理完成，订单结束');
            }
            await sessionSave(order, sessionOpt);
          }
        } catch (orderError) {
          console.warn('订单状态更新失败:', orderError.message);
        }

        try {
          await TransactionService.refundDeposit(
            report.user,
            0,
            report.order,
            '损坏赔偿已处理'
          );
        } catch (e) {}

        await NotificationService.damageReviewed(report, true, notes);
      } else {
        await report.reject(req.userId, notes);

        try {
          const order = useTransaction ? await RentalOrder.findById(report.order).session(session) : await RentalOrder.findById(report.order);
          if (order && order.status !== ORDER_STATUS.COMPLETED) {
            order.damageDetected = false;
            await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, '审核无损坏，订单完成');
          }
          await TransactionService.refundDeposit(
            report.user,
            order ? order.depositRequired : 0,
            report.order,
            '审核无损坏，退还押金'
          );
        } catch (e) {
          console.warn('押金退还失败:', e.message);
        }

        await NotificationService.damageReviewed(report, false, notes);
      }
    });

    const updated = await DamageReport.findById(req.params.id)
      .populate('compensationTransaction');

    successResponse(res, {
      report: updated,
      approved: approve,
      message: approve
        ? `审核通过，赔偿金额¥${report.totalCompensation}已处理`
        : '审核拒绝，无需赔偿',
    });
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
