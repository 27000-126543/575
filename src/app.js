require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const connectDB = require('./config/db');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { successResponse } = require('./utils/response');
const SchedulerService = require('./services/schedulerService');

const userRoutes = require('./routes/userRoutes');
const toolRoutes = require('./routes/toolRoutes');
const orderRoutes = require('./routes/orderRoutes');
const damageRoutes = require('./routes/damageRoutes');
const reportRoutes = require('./routes/reportRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(morgan('dev'));

const uploadDir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

app.get('/health', (req, res) => {
  successResponse(res, {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    mongoStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  }, '服务运行中');
});

app.get('/', (req, res) => {
  successResponse(res, {
    name: '社区共享工具租赁平台 API',
    version: '1.0.0',
    description: '支撑社区共享工具租赁平台的后端API服务',
    endpoints: {
      auth: {
        'POST /api/users/init-admin': '初始化管理员账号',
        'POST /api/users/register': '用户注册',
        'POST /api/users/login': '用户登录',
      },
      users: {
        'GET /api/users/profile': '获取个人资料',
        'PUT /api/users/profile': '更新个人资料',
        'PUT /api/users/change-password': '修改密码',
        'POST /api/users/deposit': '押金充值',
        'GET /api/users/transactions': '交易记录',
        'GET /api/users/notifications': '通知列表',
        'PUT /api/users/notifications/:id/read': '标记通知已读',
      },
      tools: {
        'GET /api/tools': '工具列表',
        'GET /api/tools/:id': '工具详情',
        'GET /api/tools/:id/calculate-price': '预估租金',
        'GET /api/tools/:id/availability': '检查可用性',
      },
      orders: {
        'POST /api/orders': '提交租赁申请',
        'GET /api/orders': '订单列表',
        'GET /api/orders/mine': '我的订单',
        'GET /api/orders/:id': '订单详情',
        'PUT /api/orders/:id/pickup': '取用工具',
        'PUT /api/orders/:id/return': '归还工具',
        'PUT /api/orders/:id/cancel': '取消订单',
      },
      damage: {
        'GET /api/damages': '损坏工单列表',
        'GET /api/damages/:id': '工单详情',
        'PUT /api/damages/:id/review': '审核工单',
      },
      reports: {
        'GET /api/reports/dashboard': '经营仪表盘',
        'GET /api/reports': '日报表列表',
        'GET /api/reports/summary': '汇总统计',
        'GET /api/reports/export': '导出Excel',
      },
    },
  }, '欢迎使用社区共享工具租赁平台API');
});

app.use('/api/users', userRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/damages', damageRoutes);
app.use('/api/reports', reportRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('未处理的Promise拒绝:', err);
});

const mongoose = require('mongoose');

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 服务启动成功`);
    console.log(`📡 端口: ${PORT}`);
    console.log(`🌍 URL: http://localhost:${PORT}`);
    console.log(`📚 API文档: http://localhost:${PORT}/`);
    console.log(`💊 健康检查: http://localhost:${PORT}/health`);
    console.log('========================================');

    try {
      SchedulerService.start();
    } catch (schedulerError) {
      console.warn('定时任务服务启动警告:', schedulerError.message);
    }
  });
}).catch((err) => {
  console.error('数据库连接失败:', err.message);
  process.exit(1);
});

module.exports = app;
