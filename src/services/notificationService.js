const { Notification, User } = require('../models');
const { NOTIFICATION_TYPE, USER_ROLE } = require('../config/constants');

class NotificationService {
  static async create(recipientId, type, title, content, extra = {}) {
    try {
      const notification = await Notification.create({
        recipient: recipientId,
        type,
        title,
        content,
        ...extra,
      });

      this.pushToUser(recipientId, notification);

      return notification;
    } catch (error) {
      console.error('创建通知失败:', error);
      return null;
    }
  }

  static async pushToUser(userId, notification) {
    console.log(`[PUSH] 推送给用户 ${userId}: ${notification.title}`);
    try {
      await Notification.findByIdAndUpdate(notification._id, {
        isPushed: true,
        pushedAt: new Date(),
        pushStatus: 'sent',
      });
    } catch (error) {
      console.error('更新推送状态失败:', error);
    }
  }

  static async notifyAdmins(type, title, content, extra = {}) {
    try {
      const admins = await User.find({ role: USER_ROLE.ADMIN, status: true });
      const notifications = await Promise.all(
        admins.map(admin =>
          Notification.create({
            recipient: admin._id,
            type,
            title,
            content,
            ...extra,
          })
        )
      );
      admins.forEach((admin, idx) => {
        this.pushToUser(admin._id, notifications[idx]);
      });
      return notifications;
    } catch (error) {
      console.error('通知管理员失败:', error);
      return [];
    }
  }

  static async orderStatus(order, statusText, userExtra = {}) {
    const userTitle = `租赁订单${statusText}`;
    const userContent = `您的订单 ${order.orderNo} ${statusText}。`;
    await this.create(
      order.user,
      NOTIFICATION_TYPE.ORDER_STATUS,
      userTitle,
      userContent,
      { order: order._id, ...userExtra }
    );

    const adminTitle = `订单${statusText}`;
    const adminContent = `订单 ${order.orderNo} 已${statusText}。`;
    await this.notifyAdmins(
      NOTIFICATION_TYPE.ORDER_STATUS,
      adminTitle,
      adminContent,
      { order: order._id }
    );
  }

  static async payment(order, amount, typeText) {
    const title = `费用${typeText}`;
    const content = `订单 ${order.orderNo} ${typeText} ¥${amount.toFixed(2)}。`;
    await this.create(
      order.user,
      NOTIFICATION_TYPE.PAYMENT,
      title,
      content,
      { order: order._id, data: { amount, type: typeText } }
    );
  }

  static async overdue(order, overdueHours, overdueFee) {
    const title = '⚠️ 租赁已逾期';
    const content = `订单 ${order.orderNo} 已逾期 ${overdueHours} 小时，产生逾期费用 ¥${overdueFee.toFixed(2)}，请尽快归还！`;
    await this.create(
      order.user,
      NOTIFICATION_TYPE.OVERDUE,
      title,
      content,
      { order: order._id, level: 'warning', data: { overdueHours, overdueFee } }
    );
  }

  static async overdueReminder(order) {
    const title = '⏰ 归还提醒';
    const hoursLeft = Math.max(0, Math.ceil((new Date(order.endTime) - new Date()) / (1000 * 60 * 60)));
    const content = hoursLeft > 0
      ? `订单 ${order.orderNo} 还有 ${hoursLeft} 小时到期，请按时归还，逾期将产生额外费用。`
      : `订单 ${order.orderNo} 已到归还时间，请尽快归还！`;
    await this.create(
      order.user,
      NOTIFICATION_TYPE.OVERDUE,
      title,
      content,
      { order: order._id, level: 'info' }
    );
  }

  static async damageCreated(damageReport) {
    const userTitle = '物品检测：发现损坏';
    const userContent = `归还的工具检测到损坏，需赔偿 ¥${damageReport.totalCompensation.toFixed(2)}，请查看详情。`;
    await this.create(
      damageReport.user,
      NOTIFICATION_TYPE.DAMAGE,
      userTitle,
      userContent,
      { damageReport: damageReport._id, order: damageReport.order, level: 'warning' }
    );

    const adminTitle = '新的损坏工单待审核';
    const adminContent = `工单 ${damageReport.reportNo} 待审核，预估赔偿 ¥${damageReport.totalCompensation.toFixed(2)}。`;
    await this.notifyAdmins(
      NOTIFICATION_TYPE.DAMAGE,
      adminTitle,
      adminContent,
      { damageReport: damageReport._id, order: damageReport.order, level: 'warning' }
    );
  }

  static async damageReviewed(damageReport, approved, adminNotes = '') {
    const title = approved ? '损坏工单审核通过' : '损坏工单审核拒绝';
    const content = approved
      ? `工单 ${damageReport.reportNo} 审核通过，需赔偿 ¥${damageReport.totalCompensation.toFixed(2)}。${adminNotes ? '备注：' + adminNotes : ''}`
      : `工单 ${damageReport.reportNo} 审核拒绝。${adminNotes ? '备注：' + adminNotes : ''}`;
    await this.create(
      damageReport.user,
      NOTIFICATION_TYPE.DAMAGE,
      title,
      content,
      { damageReport: damageReport._id, order: damageReport.order, level: approved ? 'warning' : 'success' }
    );
  }

  static async damageReminder(damageReport) {
    const title = '⚠️ 损坏工单审核超时催办';
    const content = `工单 ${damageReport.reportNo} 已超过 ${process.env.ADMIN_AUDIT_TIMEOUT_HOURS || 2} 小时未处理，请尽快审核！`;
    await this.notifyAdmins(
      NOTIFICATION_TYPE.ADMIN_ALERT,
      title,
      content,
      { damageReport: damageReport._id, order: damageReport.order, level: 'error' }
    );
  }

  static async creditUpdate(userId, delta, newScore, reason) {
    const direction = delta > 0 ? '增加' : '扣除';
    const title = '信用分变动';
    const content = `您的信用分${direction} ${Math.abs(delta)} 分（${reason}），当前 ${newScore} 分。`;
    await this.create(
      userId,
      NOTIFICATION_TYPE.CREDIT_UPDATE,
      title,
      content,
      { level: delta > 0 ? 'success' : 'warning', data: { delta, newScore, reason } }
    );
  }

  static async rentalRestricted(userId, consecutiveCount) {
    const title = '🚫 租赁权限受限';
    const content = `由于您连续 ${consecutiveCount} 次逾期归还，租赁权限已被限制30天，请珍惜信用记录。`;
    await this.create(
      userId,
      NOTIFICATION_TYPE.CREDIT_UPDATE,
      title,
      content,
      { level: 'error' }
    );
  }

  static async reportReady(report) {
    const dateStr = new Date(report.reportDate).toLocaleDateString('zh-CN');
    const title = '每日经营报表已生成';
    const content = `${dateStr} 的经营报表已生成，当日营收 ¥${report.totalRevenue.toFixed(2)}。`;
    await this.notifyAdmins(
      NOTIFICATION_TYPE.REPORT_READY,
      title,
      content,
      { report: report._id, level: 'success' }
    );
  }

  static async compensationFailed(damageReport, failReason, fullMessage = '') {
    const userTitle = '赔偿扣款失败';
    const userContent = fullMessage
      || `工单 ${damageReport.reportNo} 赔偿扣款失败（${failReason}），请补足押金余额后重试或联系客服。`;
    await this.create(
      damageReport.user,
      NOTIFICATION_TYPE.COMPENSATION_FAILED,
      userTitle,
      userContent,
      {
        damageReport: damageReport._id,
        order: damageReport.order,
        level: 'error',
        data: { failReason, totalCompensation: damageReport.totalCompensation },
      }
    );

    const adminTitle = '赔偿扣款失败需处理';
    const adminContent = `工单 ${damageReport.reportNo} 赔偿扣款失败（${failReason}），用户余额不足需补足，请跟进处理。`;
    await this.notifyAdmins(
      NOTIFICATION_TYPE.COMPENSATION_FAILED,
      adminTitle,
      adminContent,
      {
        damageReport: damageReport._id,
        order: damageReport.order,
        level: 'error',
        data: { failReason, totalCompensation: damageReport.totalCompensation },
      }
    );
  }
}

module.exports = NotificationService;
