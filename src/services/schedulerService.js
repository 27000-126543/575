const cron = require('node-cron');
const mongoose = require('mongoose');
const {
  RentalOrder, Tool, DamageReport, User, DailyReport, Notification,
} = require('../models');
const { ORDER_STATUS, DAMAGE_STATUS, USER_ROLE, TOOL_CATEGORY, REGION } = require('../config/constants');
const NotificationService = require('./notificationService');
const TransactionService = require('./transactionService');
const RealtimeService = require('./realtimeService');

class SchedulerService {
  static async checkOverdueOrders() {
    console.log('[CRON] 开始检查逾期订单...');
    const now = new Date();

    const orders = await RentalOrder.find({
      status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] },
      endTime: { $lt: now },
    }).populate('tool').populate('user');

    let processed = 0;
    let newOverdue = 0;
    let newlyRestricted = 0;

    for (const order of orders) {
      try {
        const tool = order.tool;
        const result = await order.calculateOverdue(tool, now);

        if (result.overdue && result.changed) {
          const isNewlyOverdue = order.status !== ORDER_STATUS.OVERDUE || result.overdueHours === 1;
          if (isNewlyOverdue) {
            await NotificationService.overdue(order, result.overdueHours, result.overdueFee);
            RealtimeService.broadcastOrderEvent(order, 'overdue', {
              overdueHours: result.overdueHours,
              overdueFee: result.overdueFee,
            });
            newOverdue++;
          }

          if (order.user && !order.overdueCounted) {
            const user = order.user instanceof mongoose.Document
              ? order.user
              : await User.findById(order.user);
            if (user) {
              const overdueResult = await user.recordOverdueImmediate(order._id);
              order.overdueCounted = true;
              await order.save();
              if (overdueResult.restricted) {
                await NotificationService.rentalRestricted(user._id, overdueResult.consecutiveOverdue);
                RealtimeService.emitToUser(user._id, {
                  type: 'user.restricted',
                  payload: {
                    consecutiveOverdue: overdueResult.consecutiveOverdue,
                    restrictionEndDate: user.restrictionEndDate,
                    reason: '连续逾期自动限制租赁',
                  },
                });
                newlyRestricted++;
              }
            }
          }

          if (result.overdueHours > 0 && result.overdueHours % 24 === 0) {
            try {
              const existingTxn = await require('../models/Transaction').findOne({
                order: order._id,
                type: require('../config/constants').TRANSACTION_TYPE.OVERDUE_FEE,
                createdAt: { $gte: new Date(now.getTime() - 25 * 60 * 60 * 1000) },
              });
              if (!existingTxn) {
                const userTools = await Tool.findById(tool._id);
                await TransactionService.deductOverdueFee(
                  order.user,
                  result.overdueFee,
                  order._id
                );
                if (userTools) await userTools.addRevenue(result.overdueFee);
              }
            } catch (txnErr) {
              console.warn(`订单 ${order.orderNo} 逾期费自动扣款失败:`, txnErr.message);
            }
          }
          processed++;
        }
      } catch (error) {
        console.error(`处理订单 ${order.orderNo} 逾期失败:`, error.message);
      }
    }

    console.log(`[CRON] 逾期检查完成：处理${processed}个，新增${newOverdue}个逾期，${newlyRestricted}个用户被限制`);
    return { processed, newOverdue, newlyRestricted };
  }

  static async sendReturnReminders() {
    console.log('[CRON] 开始发送归还提醒...');
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);

    const orders = await RentalOrder.find({
      status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] },
      $or: [
        { endTime: { $lte: in1Hour, $gt: now }, remindersSent: 0 },
        { endTime: { $lte: in24Hours, $gt: in1Hour }, remindersSent: { $lt: 1 } },
      ],
    }).populate('user');

    let sent = 0;
    for (const order of orders) {
      try {
        await NotificationService.overdueReminder(order);
        order.remindersSent += 1;
        order.lastReminderAt = now;
        await order.save();
        sent++;
      } catch (error) {
        console.error(`发送归还提醒失败 ${order.orderNo}:`, error.message);
      }
    }

    console.log(`[CRON] 归还提醒发送完成：${sent}条`);
    return { sent };
  }

  static async checkDamageReportTimeout() {
    console.log('[CRON] 开始检查损坏工单审核超时...');
    const timeoutMs = (parseInt(process.env.ADMIN_AUDIT_TIMEOUT_HOURS) || 2) * 60 * 60 * 1000;
    const deadline = new Date(Date.now() - timeoutMs);

    const reports = await DamageReport.find({
      status: { $in: [DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW] },
      createdAt: { $lte: deadline },
    });

    let escalated = 0;
    let reminded = 0;
    for (const report of reports) {
      try {
        if (report.isOverdue()) {
          const escalatedNow = await report.escalate(3);
          if (escalatedNow) {
            escalated++;
          }
          if (!report.lastReminderAt || (Date.now() - report.lastReminderAt.getTime() > timeoutMs)) {
            await NotificationService.damageReminder(report);
            RealtimeService.broadcastDamageEvent(report, 'reminder', { escalationLevel: report.escalationLevel });
            report.remindersSent += 1;
            report.lastReminderAt = new Date();
            await report.save();
            reminded++;
          }
        }
      } catch (error) {
        console.error(`处理工单 ${report.reportNo} 失败:`, error.message);
      }
    }

    console.log(`[CRON] 工单检查完成：升级${escalated}个，催办${reminded}个`);
    return { escalated, reminded };
  }

  static async generateDailyReport(reportDate = new Date()) {
    console.log(`[CRON] 开始生成 ${reportDate.toISOString().split('T')[0]} 经营报表...`);

    const dayStart = new Date(reportDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(reportDate);
    dayEnd.setHours(23, 59, 59, 999);

    const existing = await DailyReport.findOne({ reportDate: dayStart });
    if (existing) {
      console.log('[CRON] 报表已存在，先删除旧数据');
      await DailyReport.findByIdAndDelete(existing._id);
    }

    const report = new DailyReport({
      reportDate: dayStart,
      categoryStats: TOOL_CATEGORY.map(c => ({ category: c })),
      regionStats: REGION.map(r => ({ region: r })),
    });

    const dayOrders = await RentalOrder.find({
      createdAt: { $gte: dayStart, $lte: dayEnd },
    }).populate('tool');

    report.totalOrders = dayOrders.length;
    report.pendingOrders = dayOrders.filter(o => o.status === ORDER_STATUS.PENDING || o.status === ORDER_STATUS.APPROVED).length;
    report.overdueOrders = dayOrders.filter(o => o.hasBeenOverdue).length;

    const completedToday = await RentalOrder.find({
      status: ORDER_STATUS.COMPLETED,
      updatedAt: { $gte: dayStart, $lte: dayEnd },
    }).populate('tool').populate('user');

    report.completedOrders = completedToday.length;

    let totalRental = 0;
    let totalOverdue = 0;
    let totalUsageHours = 0;
    for (const order of completedToday) {
      totalRental += order.rentalFee || 0;
      totalOverdue += order.overdueFee || 0;
      if (order.actualStartTime && order.actualEndTime) {
        totalUsageHours += Math.max(1, Math.ceil((order.actualEndTime - order.actualStartTime) / (1000 * 60 * 60)));
      }

      if (order.tool) {
        const catStat = report.categoryStats.find(c => c.category === order.tool.category);
        if (catStat) {
          catStat.returnedCount += 1;
          catStat.revenue += (order.rentalFee || 0) + (order.overdueFee || 0);
          if (order.hasBeenOverdue) catStat.overdueCount += 1;
        }
      }
    }

    for (const order of dayOrders) {
      if (order.tool) {
        const catStat = report.categoryStats.find(c => c.category === order.tool.category);
        if (catStat) {
          catStat.rentalCount += 1;
        }
      }
    }

    const createdToday = await RentalOrder.find({
      createdAt: { $gte: dayStart, $lte: dayEnd },
      status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] },
    }).populate('tool');
    for (const order of createdToday) {
      if (order.tool) {
        const catStat = report.categoryStats.find(c => c.category === order.tool.category);
        if (catStat) {
          catStat.rentalCount += 0;
        }
      }
    }

    report.rentalRevenue = totalRental;
    report.overdueRevenue = totalOverdue;
    report.totalToolUsageHours = totalUsageHours;

    const damageReports = await DamageReport.find({
      createdAt: { $gte: dayStart, $lte: dayEnd },
    }).populate('tool');

    report.totalDamageReports = damageReports.length;
    report.pendingDamageReports = damageReports.filter(r =>
      [DAMAGE_STATUS.PENDING, DAMAGE_STATUS.UNDER_REVIEW, DAMAGE_STATUS.ESCALATED].includes(r.status)
    ).length;
    report.approvedDamageReports = damageReports.filter(r =>
      r.status === DAMAGE_STATUS.APPROVED || r.status === DAMAGE_STATUS.COMPENSATED
    ).length;

    let totalCompensation = 0;
    for (const dr of damageReports) {
      if (dr.status === DAMAGE_STATUS.APPROVED || dr.status === DAMAGE_STATUS.COMPENSATED) {
        totalCompensation += dr.totalCompensation || 0;
      }
      if (dr.tool) {
        const catStat = report.categoryStats.find(c => c.category === dr.tool.category);
        if (catStat) {
          catStat.damageCount += 1;
        }
      }
    }
    report.compensationRevenue = totalCompensation;
    report.totalRevenue = totalRental + totalOverdue + totalCompensation;

    const refundTxns = await require('../models/Transaction').find({
      type: require('../config/constants').TRANSACTION_TYPE.REFUND,
      createdAt: { $gte: dayStart, $lte: dayEnd },
    });
    report.depositRefunds = refundTxns.reduce((s, t) => s + t.amount, 0);

    const newUsers = await User.countDocuments({
      createdAt: { $gte: dayStart, $lte: dayEnd },
      role: USER_ROLE.USER,
    });
    report.newUsers = newUsers;

    const activeUserIds = new Set();
    for (const order of [...dayOrders, ...completedToday]) {
      if (order.user) activeUserIds.add(order.user.toString());
    }
    report.activeUsers = activeUserIds.size;

    const restrictedUsers = await User.countDocuments({
      isRentalRestricted: true,
    });
    report.restrictedUsers = restrictedUsers;

    const allTools = await Tool.find({});
    for (const tool of allTools) {
      const catStat = report.categoryStats.find(c => c.category === tool.category);
      if (catStat) {
        catStat.totalTools += tool.totalStock || 0;
      }
    }

    for (const order of completedToday) {
      if (order.tool && order.tool.region) {
        const regionStat = report.regionStats.find(r => r.region === order.tool.region);
        if (regionStat) {
          regionStat.returnedCount += 1;
          regionStat.revenue += (order.rentalFee || 0) + (order.overdueFee || 0);
          if (order.hasBeenOverdue) regionStat.overdueCount += 1;
        }
      }
    }

    for (const order of dayOrders) {
      if (order.tool && order.tool.region) {
        const regionStat = report.regionStats.find(r => r.region === order.tool.region);
        if (regionStat) {
          regionStat.rentalCount += 1;
        }
      }
    }

    for (const dr of damageReports) {
      if (dr.tool && dr.tool.region) {
        const regionStat = report.regionStats.find(r => r.region === dr.tool.region);
        if (regionStat) {
          regionStat.damageCount += 1;
          if (dr.status === DAMAGE_STATUS.APPROVED || dr.status === DAMAGE_STATUS.COMPENSATED) {
            regionStat.revenue += dr.totalCompensation || 0;
          }
        }
      }
    }

    const regionUserMap = {};
    for (const order of [...dayOrders, ...completedToday]) {
      const u = order.user;
      if (u && u.region) {
        if (!regionUserMap[u.region]) regionUserMap[u.region] = new Set();
        regionUserMap[u.region].add(u._id.toString());
      }
    }
    for (const regionStat of report.regionStats) {
      regionStat.activeUsers = (regionUserMap[regionStat.region] || []).length || 0;
    }

    report.categoryStats = report.categoryStats.filter(c => c.totalTools > 0 || c.rentalCount > 0);
    report.regionStats = report.regionStats.filter(r => r.rentalCount > 0 || r.activeUsers > 0);

    report.activeRentals = await RentalOrder.countDocuments({
      status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] },
    });

    report.recalculateRates();
    report.isGenerated = true;
    report.generatedAt = new Date();
    await report.save();

    await NotificationService.reportReady(report);
    RealtimeService.emitToAdmins({
      type: 'report.ready',
      payload: {
        reportId: report._id,
        reportDate: report.reportDate,
        totalRevenue: report.totalRevenue,
      },
    });

    console.log(`[CRON] 经营报表生成完成：当日营收¥${report.totalRevenue.toFixed(2)}`);
    return report;
  }

  static start() {
    console.log('[Scheduler] 定时任务服务已启动');

    cron.schedule('*/30 * * * *', () => {
      this.checkOverdueOrders().catch(e => console.error('逾期检查失败:', e));
    });

    cron.schedule('0 * * * *', () => {
      this.sendReturnReminders().catch(e => console.error('归还提醒失败:', e));
    });

    cron.schedule('*/15 * * * *', () => {
      this.checkDamageReportTimeout().catch(e => console.error('工单超时检查失败:', e));
    });

    cron.schedule('0 0 0 * * *', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      this.generateDailyReport(yesterday).catch(e => console.error('日报表生成失败:', e));
    });

    console.log('[Scheduler] 已注册任务：');
    console.log('  - 每30分钟：检查逾期订单');
    console.log('  - 每小时：发送归还提醒');
    console.log('  - 每15分钟：检查工单审核超时');
    console.log('  - 每日00:00：生成前一日经营报表');
  }

  static async runAllOnce() {
    console.log('[Scheduler] 手动执行所有任务...');
    const results = {};
    results.overdue = await this.checkOverdueOrders();
    results.reminders = await this.sendReturnReminders();
    results.damage = await this.checkDamageReportTimeout();
    results.report = await this.generateDailyReport();
    console.log('[Scheduler] 手动执行完成:', results);
    return results;
  }
}

module.exports = SchedulerService;
