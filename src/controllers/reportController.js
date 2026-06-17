const ExcelJS = require('exceljs');
const { DailyReport, RentalOrder, User, Tool, DamageReport, Transaction } = require('../models');
const { successResponse, paginatedResponse, NotFoundError, BadRequestError } = require('../utils/response');
const { getPaginationParams, asyncHandler, parseDateStartEnd, formatDate } = require('../utils/helpers');
const { ORDER_STATUS, TRANSACTION_TYPE } = require('../config/constants');
const SchedulerService = require('../services/schedulerService');

const reportController = {
  list: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = { isGenerated: true };

    if (req.query.startDate || req.query.endDate) {
      filter.reportDate = {};
      if (req.query.startDate) filter.reportDate.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.reportDate.$lte = new Date(req.query.endDate);
    }

    const [reports, total] = await Promise.all([
      DailyReport.find(filter)
        .sort({ reportDate: -1 })
        .skip(skip)
        .limit(pageSize),
      DailyReport.countDocuments(filter),
    ]);

    paginatedResponse(res, reports, total, page, pageSize);
  }),

  getByDate: asyncHandler(async (req, res) => {
    const date = req.params.date;
    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) {
      throw new BadRequestError('日期格式无效');
    }
    reportDate.setHours(0, 0, 0, 0);

    let report = await DailyReport.findOne({ reportDate });
    if (!report) {
      report = await SchedulerService.generateDailyReport(reportDate);
    }

    successResponse(res, report);
  }),

  getSummary: asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    const { start, end } = parseDateStartEnd(startDate, endDate);

    const filter = {};
    if (start && end) {
      filter.reportDate = { $gte: start, $lte: end };
    } else if (start) {
      filter.reportDate = { $gte: start };
    } else if (end) {
      filter.reportDate = { $lte: end };
    }

    const reports = await DailyReport.find(filter).sort({ reportDate: 1 });

    const summary = {
      period: {
        start: start ? formatDate(start, 'YYYY-MM-DD') : null,
        end: end ? formatDate(end, 'YYYY-MM-DD') : null,
      },
      totalDays: reports.length,
      totalOrders: 0,
      totalRevenue: 0,
      totalRentalRevenue: 0,
      totalOverdueRevenue: 0,
      totalCompensationRevenue: 0,
      totalDepositRefunds: 0,
      totalNewUsers: 0,
      totalActiveUsers: 0,
      totalDamageReports: 0,
      avgDailyRevenue: 0,
      avgOrderValue: 0,
      overallDamageRate: 0,
      categoryStats: {},
      regionStats: {},
      dailyTrend: [],
    };

    const categoryAgg = {};
    const regionAgg = {};

    for (const report of reports) {
      summary.totalOrders += report.totalOrders || 0;
      summary.totalRevenue += report.totalRevenue || 0;
      summary.totalRentalRevenue += report.rentalRevenue || 0;
      summary.totalOverdueRevenue += report.overdueRevenue || 0;
      summary.totalCompensationRevenue += report.compensationRevenue || 0;
      summary.totalDepositRefunds += report.depositRefunds || 0;
      summary.totalNewUsers += report.newUsers || 0;
      summary.totalDamageReports += report.totalDamageReports || 0;

      summary.dailyTrend.push({
        date: formatDate(report.reportDate, 'YYYY-MM-DD'),
        orders: report.totalOrders,
        revenue: report.totalRevenue,
        completed: report.completedOrders,
        damage: report.totalDamageReports,
      });

      (report.categoryStats || []).forEach(cs => {
        if (!categoryAgg[cs.category]) {
          categoryAgg[cs.category] = {
            category: cs.category,
            rentalCount: 0,
            returnedCount: 0,
            damageCount: 0,
            revenue: 0,
          };
        }
        categoryAgg[cs.category].rentalCount += cs.rentalCount || 0;
        categoryAgg[cs.category].returnedCount += cs.returnedCount || 0;
        categoryAgg[cs.category].damageCount += cs.damageCount || 0;
        categoryAgg[cs.category].revenue += cs.revenue || 0;
      });

      (report.regionStats || []).forEach(rs => {
        if (!regionAgg[rs.region]) {
          regionAgg[rs.region] = {
            region: rs.region,
            rentalCount: 0,
            revenue: 0,
            damageCount: 0,
            activeUsers: 0,
          };
        }
        regionAgg[rs.region].rentalCount += rs.rentalCount || 0;
        regionAgg[rs.region].revenue += rs.revenue || 0;
        regionAgg[rs.region].damageCount += rs.damageCount || 0;
        regionAgg[rs.region].activeUsers = Math.max(regionAgg[rs.region].activeUsers, rs.activeUsers || 0);
      });
    }

    if (reports.length > 0) {
      summary.avgDailyRevenue = parseFloat((summary.totalRevenue / reports.length).toFixed(2));
      summary.avgOrderValue = summary.totalOrders > 0
        ? parseFloat((summary.totalRevenue / summary.totalOrders).toFixed(2))
        : 0;
      const totalReturned = Object.values(categoryAgg).reduce((s, c) => s + c.returnedCount, 0);
      const totalDamage = Object.values(categoryAgg).reduce((s, c) => s + c.damageCount, 0);
      summary.overallDamageRate = totalReturned > 0
        ? parseFloat(((totalDamage / totalReturned) * 100).toFixed(2))
        : 0;
    }

    const maxActive = Math.max(...Object.values(regionAgg).map(r => r.activeUsers), 0);
    summary.totalActiveUsers = maxActive;

    summary.categoryStats = Object.values(categoryAgg).map(cs => ({
      ...cs,
      turnoverRate: summary.totalOrders > 0
        ? parseFloat(((cs.rentalCount / summary.totalOrders) * 100).toFixed(2))
        : 0,
      damageRate: cs.returnedCount > 0
        ? parseFloat(((cs.damageCount / cs.returnedCount) * 100).toFixed(2))
        : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    summary.regionStats = Object.values(regionAgg).sort((a, b) => b.revenue - a.revenue);

    successResponse(res, summary);
  }),

  exportExcel: asyncHandler(async (req, res) => {
    const { startDate, endDate, type = 'summary' } = req.query;
    const { start, end } = parseDateStartEnd(startDate, endDate);

    const filter = { isGenerated: true };
    if (start && end) {
      filter.reportDate = { $gte: start, $lte: end };
    } else if (start) {
      filter.reportDate = { $gte: start };
    } else if (end) {
      filter.reportDate = { $lte: end };
    }

    const reports = await DailyReport.find(filter).sort({ reportDate: 1 });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '工具租赁平台';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('经营总览');
    summarySheet.columns = [
      { header: '日期', key: 'date', width: 15 },
      { header: '订单数', key: 'totalOrders', width: 10 },
      { header: '完成数', key: 'completedOrders', width: 10 },
      { header: '活跃租赁', key: 'activeRentals', width: 12 },
      { header: '逾期数', key: 'overdueOrders', width: 10 },
      { header: '新增用户', key: 'newUsers', width: 10 },
      { header: '活跃用户', key: 'activeUsers', width: 10 },
      { header: '租赁收入', key: 'rentalRevenue', width: 12 },
      { header: '逾期收入', key: 'overdueRevenue', width: 12 },
      { header: '赔偿收入', key: 'compensationRevenue', width: 12 },
      { header: '总营收', key: 'totalRevenue', width: 12 },
      { header: '押金退还', key: 'depositRefunds', width: 12 },
      { header: '损坏工单数', key: 'totalDamageReports', width: 12 },
      { header: '损坏率(%)', key: 'damageRate', width: 10 },
      { header: '平均租期(h)', key: 'avgDuration', width: 12 },
      { header: '平均客单价', key: 'avgOrderValue', width: 12 },
    ];

    for (const report of reports) {
      summarySheet.addRow({
        date: formatDate(report.reportDate, 'YYYY-MM-DD'),
        totalOrders: report.totalOrders,
        completedOrders: report.completedOrders,
        activeRentals: report.activeRentals,
        overdueOrders: report.overdueOrders,
        newUsers: report.newUsers,
        activeUsers: report.activeUsers,
        rentalRevenue: report.rentalRevenue,
        overdueRevenue: report.overdueRevenue,
        compensationRevenue: report.compensationRevenue,
        totalRevenue: report.totalRevenue,
        depositRefunds: report.depositRefunds,
        totalDamageReports: report.totalDamageReports,
        damageRate: report.overallDamageRate,
        avgDuration: report.avgRentalDurationHours,
        avgOrderValue: report.avgOrderValue,
      });
    }

    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };

    const categorySheet = workbook.addWorksheet('分类统计');
    categorySheet.columns = [
      { header: '日期', key: 'date', width: 15 },
      { header: '类别', key: 'category', width: 15 },
      { header: '工具数', key: 'totalTools', width: 10 },
      { header: '租赁数', key: 'rentalCount', width: 10 },
      { header: '归还数', key: 'returnedCount', width: 10 },
      { header: '损坏数', key: 'damageCount', width: 10 },
      { header: '逾期数', key: 'overdueCount', width: 10 },
      { header: '收入', key: 'revenue', width: 12 },
      { header: '周转率(%)', key: 'turnoverRate', width: 10 },
      { header: '损坏率(%)', key: 'damageRate', width: 10 },
    ];

    for (const report of reports) {
      for (const cs of (report.categoryStats || [])) {
        categorySheet.addRow({
          date: formatDate(report.reportDate, 'YYYY-MM-DD'),
          category: cs.category,
          totalTools: cs.totalTools,
          rentalCount: cs.rentalCount,
          returnedCount: cs.returnedCount,
          damageCount: cs.damageCount,
          overdueCount: cs.overdueCount,
          revenue: cs.revenue,
          turnoverRate: cs.turnoverRate,
          damageRate: cs.damageRate,
        });
      }
    }

    categorySheet.getRow(1).font = { bold: true };
    categorySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F7E8' } };

    const regionSheet = workbook.addWorksheet('区域统计');
    regionSheet.columns = [
      { header: '日期', key: 'date', width: 15 },
      { header: '区域', key: 'region', width: 12 },
      { header: '租赁数', key: 'rentalCount', width: 10 },
      { header: '活跃用户', key: 'activeUsers', width: 12 },
      { header: '损坏数', key: 'damageCount', width: 10 },
      { header: '收入', key: 'revenue', width: 12 },
    ];

    for (const report of reports) {
      for (const rs of (report.regionStats || [])) {
        regionSheet.addRow({
          date: formatDate(report.reportDate, 'YYYY-MM-DD'),
          region: rs.region,
          rentalCount: rs.rentalCount,
          activeUsers: rs.activeUsers,
          damageCount: rs.damageCount,
          revenue: rs.revenue,
        });
      }
    }

    regionSheet.getRow(1).font = { bold: true };
    regionSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5E6' } };

    const startStr = start ? formatDate(start, 'YYYYMMDD') : 'all';
    const endStr = end ? formatDate(end, 'YYYYMMDD') : 'all';
    const filename = `经营报表_${startStr}_${endStr}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    await workbook.xlsx.write(res);
    res.end();
  }),

  generateToday: asyncHandler(async (req, res) => {
    const today = new Date();
    const report = await SchedulerService.generateDailyReport(today);
    successResponse(res, report, '今日经营报表已生成');
  }),

  generateCustom: asyncHandler(async (req, res) => {
    const { date } = req.body;
    if (!date) throw new BadRequestError('请指定日期');

    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) throw new BadRequestError('日期格式无效');

    const report = await SchedulerService.generateDailyReport(reportDate);
    successResponse(res, report, `经营报表已生成：${formatDate(reportDate, 'YYYY-MM-DD')}`);
  }),

  runScheduledTasks: asyncHandler(async (req, res) => {
    const results = await SchedulerService.runAllOnce();
    successResponse(res, results, '所有定时任务已手动执行完成');
  }),

  getDashboard: asyncHandler(async (req, res) => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalTools,
      activeOrders,
      pendingDamage,
      todayOrders,
      todayRevenue,
      totalRevenueAll,
      overdueCount,
    ] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      Tool.countDocuments({ status: true }),
      RentalOrder.countDocuments({ status: { $in: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.OVERDUE] } }),
      DamageReport.countDocuments({ status: { $in: ['pending', 'under_review', 'escalated'] } }),
      RentalOrder.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      Transaction.aggregate([
        { $match: { createdAt: { $gte: today, $lt: tomorrow }, direction: 'out' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { direction: 'out' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      RentalOrder.countDocuments({ hasBeenOverdue: true }),
    ]);

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      const report = await DailyReport.findOne({ reportDate: d });
      last7Days.push({
        date: formatDate(d, 'MM-DD'),
        orders: report ? report.totalOrders : 0,
        revenue: report ? report.totalRevenue : 0,
      });
    }

    successResponse(res, {
      totalUsers,
      totalTools,
      activeOrders,
      pendingDamage,
      todayOrders,
      todayRevenue: (todayRevenue[0] && todayRevenue[0].total) || 0,
      totalRevenue: (totalRevenueAll[0] && totalRevenueAll[0].total) || 0,
      overdueCount,
      last7Days,
    });
  }),
};

module.exports = reportController;
