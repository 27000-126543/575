const mongoose = require('mongoose');
const { RentalOrder, Tool, DamageReport, User } = require('../models');
const {
  successResponse, paginatedResponse,
  BadRequestError, NotFoundError, ForbiddenError,
} = require('../utils/response');
const {
  getPaginationParams, asyncHandler, validateDateRange,
  generateOrderNo, generateReportNo, simulateImageComparison,
  withTransaction, sessionSave, sessionCreate,
} = require('../utils/helpers');
const { ORDER_STATUS, DAMAGE_STATUS, USER_ROLE } = require('../config/constants');
const TransactionService = require('../services/transactionService');
const NotificationService = require('../services/notificationService');
const RealtimeService = require('../services/realtimeService');

const orderController = {
  create: asyncHandler(async (req, res) => {
    const result = await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      const { toolId, startTime, endTime, quantity = 1, notes } = req.body;

      if (!toolId || !startTime || !endTime) {
        throw new BadRequestError('请填写工具、开始时间和结束时间');
      }

      const dateCheck = validateDateRange(startTime, endTime);
      if (!dateCheck.valid) {
        throw new BadRequestError(dateCheck.message);
      }

      const tool = useTransaction ? await Tool.findById(toolId).session(session) : await Tool.findById(toolId);
      if (!tool) {
        throw new NotFoundError('工具不存在');
      }
      if (!tool.status) {
        throw new BadRequestError('该工具已下架');
      }

      const rent = tool.calculateRent(startTime, endTime);
      if (rent.duration.totalHours < 1) {
        throw new BadRequestError('租期至少1小时');
      }
      if (rent.duration.days > tool.maxRentalDays) {
        throw new BadRequestError(`租期不能超过${tool.maxRentalDays}天`);
      }

      const user = useTransaction ? await User.findById(req.userId).session(session) : await User.findById(req.userId);
      if (!user) {
        throw new NotFoundError('用户不存在');
      }

      const totalDeposit = tool.deposit * quantity;
      const totalRent = rent.totalRent * quantity;

      const rentCheck = user.canRent(totalDeposit);
      if (!rentCheck.allowed) {
        const orderData = {
          orderNo: generateOrderNo(),
          user: req.userId,
          tool: toolId,
          quantity,
          startTime: dateCheck.start,
          endTime: dateCheck.end,
          rentalFee: totalRent,
          periodBreakdown: rent.periodBreakdown.map(p => ({
            ...p,
            subtotal: p.subtotal * quantity,
          })),
          depositRequired: totalDeposit,
          totalAmount: totalRent,
          status: ORDER_STATUS.REJECTED,
          rejectionReason: rentCheck.reason,
          notes,
        };
        const order = await sessionCreate(RentalOrder, orderData, sessionOpt);

        return {
          type: 'rejected',
          order,
          reason: rentCheck.reason,
          rent,
        };
      }

      if ((tool.availableStock || 0) < quantity) {
        throw new BadRequestError(`库存不足，当前可用${tool.availableStock}件`);
      }

      await tool.lockStock(quantity);

      try {
        await TransactionService.freezeDeposit(
          req.userId,
          totalDeposit,
          null,
          null
        );
      } catch (freezeErr) {
        await tool.unlockStock(quantity);
        throw new BadRequestError(`押金冻结失败: ${freezeErr.message}`);
      }

      const orderData = {
        orderNo: generateOrderNo(),
        user: req.userId,
        tool: toolId,
        quantity,
        startTime: dateCheck.start,
        endTime: dateCheck.end,
        rentalFee: totalRent,
        periodBreakdown: rent.periodBreakdown.map(p => ({
          ...p,
          subtotal: p.subtotal * quantity,
        })),
        depositRequired: totalDeposit,
        depositFrozen: true,
        totalAmount: totalRent,
        status: ORDER_STATUS.APPROVED,
        notes,
      };
      const order = await sessionCreate(RentalOrder, orderData, sessionOpt);

      try {
        const { Transaction } = require('../models');
        await Transaction.findOneAndUpdate(
          { user: req.userId, type: 'deposit_freeze', order: null },
          { order: order._id },
          { sort: { createdAt: -1 } }
        );
      } catch (_) {}

      await NotificationService.orderStatus(order, '申请通过', {
        data: {
          rentalFee: totalRent,
          deposit: totalDeposit,
        },
      });
      RealtimeService.broadcastOrderEvent(order, 'approved', {
        rentalFee: totalRent,
        deposit: totalDeposit,
      });

      return {
        type: 'approved',
        order,
        rent,
      };
    });

    if (result.type === 'rejected') {
      RealtimeService.broadcastOrderEvent(result.order, 'rejected', { reason: result.reason });
      return successResponse(res, {
        order: result.order,
        rejected: true,
        reason: result.reason,
      }, result.reason);
    }

    const populated = await RentalOrder.findById(result.order._id)
      .populate('tool', 'name category images deposit')
      .populate('user', 'username realName phone region');

    successResponse(res, {
      order: populated,
      rent: result.rent,
    }, '租赁申请提交成功，库存已锁定', 201);
  }),

  list: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = {};

    if (req.user.role !== USER_ROLE.ADMIN) {
      filter.user = req.userId;
    } else if (req.query.userId) {
      filter.user = req.query.userId;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.toolId) filter.tool = req.query.toolId;

    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
    }

    const [orders, total] = await Promise.all([
      RentalOrder.find(filter)
        .populate('tool', 'name category images')
        .populate('user', 'username realName phone region')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      RentalOrder.countDocuments(filter),
    ]);

    paginatedResponse(res, orders, total, page, pageSize);
  }),

  getById: asyncHandler(async (req, res) => {
    const order = await RentalOrder.findById(req.params.id)
      .populate('tool')
      .populate('user', 'username realName phone region')
      .populate('damageReport');

    if (!order) {
      throw new NotFoundError('订单不存在');
    }

    if (req.user.role !== USER_ROLE.ADMIN && order.user._id.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权查看此订单');
    }

    successResponse(res, order);
  }),

  pickUp: asyncHandler(async (req, res) => {
    const { pickupImages = [] } = req.body;

    const order = await RentalOrder.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('订单不存在');
    }
    if (req.user.role !== USER_ROLE.ADMIN && order.user.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权操作此订单');
    }
    if (order.status !== ORDER_STATUS.APPROVED && order.status !== ORDER_STATUS.PENDING) {
      throw new BadRequestError(`当前订单状态不允许取用（状态：${order.status}）`);
    }

    const result = await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      const tool = useTransaction ? await Tool.findById(order.tool).session(session) : await Tool.findById(order.tool);
      await tool.pickUp(order.quantity);

      order.pickupImages = pickupImages;
      await order.markPickedUp();

      let txnResult;
      try {
        txnResult = await TransactionService.deductRentalFee(
          order.user,
          order.rentalFee,
          order._id
        );
        order.paidAmount = order.rentalFee;
        await sessionSave(order, sessionOpt);
        await NotificationService.payment(order, order.rentalFee, '已扣除');
        await tool.addRevenue(order.rentalFee);
      } catch (txnError) {
        console.warn('租金自动扣费失败，将稍后重试:', txnError.message);
      }

      await NotificationService.orderStatus(order, '用户已取用', {
        data: { actualStartTime: order.actualStartTime },
      });
      RealtimeService.broadcastOrderEvent(order, 'picked_up', {
        actualStartTime: order.actualStartTime,
      });

      return { txnResult };
    });

    successResponse(res, {
      order,
      transaction: result.txnResult ? result.txnResult.transaction : null,
      message: result.txnResult ? '取用成功，租金已自动扣除' : '取用成功，租金扣除待处理',
    });
  }),

  returnTool: asyncHandler(async (req, res) => {
    const { returnImages = [] } = req.body;
    if (!returnImages || returnImages.length === 0) {
      throw new BadRequestError('请上传归还时的物品照片');
    }

    const order = await RentalOrder.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('订单不存在');
    }
    if (req.user.role !== USER_ROLE.ADMIN && order.user.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权操作此订单');
    }
    if (![ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE].includes(order.status)) {
      throw new BadRequestError(`当前订单状态不允许归还（状态：${order.status}）`);
    }

    const result = await withTransaction(async ({ session, useTransaction }) => {
      const sessionOpt = useTransaction ? session : null;

      const tool = useTransaction ? await Tool.findById(order.tool).session(session) : await Tool.findById(order.tool);

      await order.markReturned(returnImages);
      await tool.returnStock(order.quantity);

      if (order.hasBeenOverdue && order.overdueFee > 0) {
        const user = useTransaction ? await User.findById(order.user).session(session) : await User.findById(order.user);
        const overdueResult = await user.recordOverdue(order._id);
        if (overdueResult.restricted) {
          await NotificationService.rentalRestricted(user._id, overdueResult.consecutiveOverdue);
          RealtimeService.emitToUser(user._id, {
            type: 'user.restricted',
            payload: {
              consecutiveOverdue: overdueResult.consecutiveOverdue,
              restrictionEndDate: user.restrictionEndDate,
            },
          });
        }

        try {
          const overdueTxn = await TransactionService.deductOverdueFee(
            order.user,
            order.overdueFee,
            order._id
          );
          order.paidAmount = (order.paidAmount || 0) + order.overdueFee;
          await sessionSave(order, sessionOpt);
          await NotificationService.payment(order, order.overdueFee, '逾期费用已扣除');
          await tool.addRevenue(order.overdueFee);
        } catch (txnError) {
          console.warn('逾期费用自动扣除失败:', txnError.message);
        }
      } else {
        const user = useTransaction ? await User.findById(order.user).session(session) : await User.findById(order.user);
        if (user.consecutiveOverdue > 0) {
          await user.clearOverdueStreak();
        }
      }

      const comparison = simulateImageComparison(order.pickupImages || [], returnImages);

      let damageReport = null;
      if (comparison.damageFound) {
        order.damageDetected = true;
        await order.updateStatus(ORDER_STATUS.DAMAGED, null, '检测到物品损坏');
        order.status = ORDER_STATUS.DAMAGED;
        await sessionSave(order, sessionOpt);

        const damageData = {
          reportNo: generateReportNo(),
          order: order._id,
          user: order.user,
          tool: tool._id,
          damages: comparison.damages,
          pickupImages: order.pickupImages || [],
          returnImages,
          comparisonResult: {
            confidence: comparison.confidence,
            damageFound: true,
            details: comparison.details,
          },
          totalCompensation: comparison.damages.reduce((s, d) => s + d.estimatedCost, 0),
        };
        damageReport = await sessionCreate(DamageReport, damageData, sessionOpt);

        order.damageReport = damageReport._id;
        await sessionSave(order, sessionOpt);

        await tool.recordDamage();

        await NotificationService.damageCreated(damageReport);
        RealtimeService.broadcastDamageEvent(damageReport, 'created');
      } else {
        await order.complete();
        if (order.depositFrozen && order.depositRequired > 0) {
          try {
            await TransactionService.unfreezeDeposit(
              order.user,
              order.depositRequired,
              order._id,
              '订单无损坏完成，释放冻结押金'
            );
          } catch (txnError) {
            console.warn('押金释放失败:', txnError.message);
          }
        }
        await NotificationService.orderStatus(order, '已完成');
        RealtimeService.broadcastOrderEvent(order, 'completed');
      }

      return { damageReport, comparison };
    });

    successResponse(res, {
      order,
      damageReport: result.damageReport,
      comparison: {
        damageFound: result.comparison.damageFound,
        confidence: result.comparison.confidence,
        damages: result.comparison.damages,
      },
      message: result.comparison.damageFound
        ? '归还成功，检测到物品损坏，已生成赔偿工单'
        : '归还成功，订单已完成，押金已退还',
    });
  }),

  cancel: asyncHandler(async (req, res) => {
    const order = await RentalOrder.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('订单不存在');
    }
    if (req.user.role !== USER_ROLE.ADMIN && order.user.toString() !== req.userId.toString()) {
      throw new ForbiddenError('无权操作此订单');
    }

    if (![ORDER_STATUS.PENDING, ORDER_STATUS.APPROVED].includes(order.status)) {
      throw new BadRequestError(`当前订单状态不允许取消（状态：${order.status}）`);
    }

    await withTransaction(async ({ session, useTransaction }) => {
      const tool = useTransaction ? await Tool.findById(order.tool).session(session) : await Tool.findById(order.tool);
      if (tool && order.status === ORDER_STATUS.APPROVED) {
        await tool.unlockStock(order.quantity);
      }

      if (order.depositFrozen && order.depositRequired > 0) {
        try {
          await TransactionService.unfreezeDeposit(
            order.user,
            order.depositRequired,
            order._id,
            '取消订单，释放冻结押金'
          );
        } catch (freezeErr) {
          console.warn('取消订单时押金释放失败:', freezeErr.message);
        }
      }

      await order.updateStatus(ORDER_STATUS.CANCELLED, req.userId, '用户取消订单');
      await NotificationService.orderStatus(order, '已取消');
      RealtimeService.broadcastOrderEvent(order, 'cancelled');
    });

    successResponse(res, { order }, '订单已取消');
  }),

  rejectByAdmin: asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) {
      throw new BadRequestError('请填写拒绝原因');
    }

    const order = await RentalOrder.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('订单不存在');
    }
    if (order.status !== ORDER_STATUS.PENDING) {
      throw new BadRequestError(`当前订单状态不允许拒绝（状态：${order.status}）`);
    }

    const tool = await Tool.findById(order.tool);
    if (tool) {
      await tool.unlockStock(order.quantity);
    }

    await order.reject(reason);
    await NotificationService.orderStatus(order, `被拒绝（${reason}）`);

    successResponse(res, { order }, '订单已拒绝');
  }),

  getMyOrders: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = { user: req.userId };
    if (req.query.status) filter.status = req.query.status;

    const [orders, total] = await Promise.all([
      RentalOrder.find(filter)
        .populate('tool', 'name category images')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      RentalOrder.countDocuments(filter),
    ]);

    const stats = {
      total,
      statusCounts: {},
    };
    const allMyOrders = await RentalOrder.find({ user: req.userId });
    allMyOrders.forEach(o => {
      stats.statusCounts[o.status] = (stats.statusCounts[o.status] || 0) + 1;
    });

    successResponse(res, {
      list: orders,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
      stats,
    });
  }),

  getStatistics: asyncHandler(async (req, res) => {
    const pipeline = [
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalRentalFee: { $sum: '$rentalFee' },
          totalOverdueFee: { $sum: '$overdueFee' },
        },
      },
    ];

    const byStatus = await RentalOrder.aggregate(pipeline);
    const totalOrders = byStatus.reduce((s, g) => s + g.count, 0);
    const totalRevenue = byStatus.reduce((s, g) => s + g.totalRentalFee + g.totalOverdueFee, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = await RentalOrder.countDocuments({ createdAt: { $gte: today } });

    const activeOrders = await RentalOrder.countDocuments({
      status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] },
    });

    successResponse(res, {
      totalOrders,
      totalRevenue,
      todayOrders,
      activeOrders,
      byStatus,
    });
  }),

  forceComplete: asyncHandler(async (req, res) => {
    const { reason } = req.body;

    const order = await RentalOrder.findById(req.params.id);
    if (!order) {
      throw new NotFoundError('订单不存在');
    }

    if (order.status === ORDER_STATUS.COMPLETED) {
      throw new BadRequestError('订单已完成');
    }

    await order.updateStatus(ORDER_STATUS.COMPLETED, req.userId, `管理员强制完成：${reason || '无'}`);
    await NotificationService.orderStatus(order, '已完成（管理员处理）');

    successResponse(res, { order }, '订单已强制完成');
  }),
};

module.exports = orderController;
