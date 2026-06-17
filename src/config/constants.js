const ORDER_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PICKED_UP: 'picked_up',
  RETURNED: 'returned',
  OVERDUE: 'overdue',
  DAMAGED: 'damaged',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const DAMAGE_STATUS = {
  PENDING: 'pending',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  COMPENSATED: 'compensated',
  ESCALATED: 'escalated',
};

const NOTIFICATION_TYPE = {
  ORDER_STATUS: 'order_status',
  PAYMENT: 'payment',
  OVERDUE: 'overdue',
  DAMAGE: 'damage',
  ADMIN_ALERT: 'admin_alert',
  CREDIT_UPDATE: 'credit_update',
  REPORT_READY: 'report_ready',
};

const USER_ROLE = {
  USER: 'user',
  ADMIN: 'admin',
};

const TRANSACTION_TYPE = {
  DEPOSIT: 'deposit',
  RENTAL_FEE: 'rental_fee',
  OVERDUE_FEE: 'overdue_fee',
  COMPENSATION: 'compensation',
  REFUND: 'refund',
};

const TOOL_CATEGORY = [
  '电动工具',
  '手动工具',
  '园艺工具',
  '清洁设备',
  '测量仪器',
  '木工工具',
  '水暖工具',
  '其他',
];

const REGION = [
  '东城区',
  '西城区',
  '朝阳区',
  '海淀区',
  '丰台区',
  '石景山区',
  '通州区',
  '昌平区',
];

module.exports = {
  ORDER_STATUS,
  DAMAGE_STATUS,
  NOTIFICATION_TYPE,
  USER_ROLE,
  TRANSACTION_TYPE,
  TOOL_CATEGORY,
  REGION,
};
