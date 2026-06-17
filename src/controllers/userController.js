const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { successResponse, paginatedResponse, BadRequestError, UnauthorizedError, NotFoundError, ForbiddenError } = require('../utils/response');
const { getPaginationParams, asyncHandler } = require('../utils/helpers');
const { USER_ROLE } = require('../config/constants');
const TransactionService = require('../services/transactionService');
const NotificationService = require('../services/notificationService');

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const userController = {
  register: asyncHandler(async (req, res) => {
    const { username, password, realName, phone, email, region, address } = req.body;

    if (!username || !password || !realName || !phone || !region) {
      throw new BadRequestError('请填写必填字段');
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { phone }],
    });
    if (existingUser) {
      throw new BadRequestError('用户名或手机号已注册');
    }

    const user = await User.create({
      username,
      password,
      realName,
      phone,
      email,
      region,
      address,
      role: USER_ROLE.USER,
    });

    const token = generateToken(user._id);
    user.password = undefined;

    successResponse(res, {
      user,
      token,
    }, '注册成功', 201);
  }),

  login: asyncHandler(async (req, res) => {
    const { username, password, phone } = req.body;

    if (!(username || phone) || !password) {
      throw new BadRequestError('请输入账号和密码');
    }

    const query = {};
    if (username) query.username = username;
    if (phone) query.phone = phone;

    const user = await User.findOne(query).select('+password');
    if (!user) {
      throw new UnauthorizedError('账号或密码错误');
    }

    if (!user.status) {
      throw new ForbiddenError('账号已被禁用');
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      throw new UnauthorizedError('账号或密码错误');
    }

    const token = generateToken(user._id);
    user.password = undefined;

    successResponse(res, {
      user,
      token,
    }, '登录成功');
  }),

  getProfile: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) {
      throw new NotFoundError('用户不存在');
    }
    successResponse(res, user);
  }),

  updateProfile: asyncHandler(async (req, res) => {
    const { realName, email, address, avatar } = req.body;
    const updateData = {};
    if (realName !== undefined) updateData.realName = realName;
    if (email !== undefined) updateData.email = email;
    if (address !== undefined) updateData.address = address;
    if (avatar !== undefined) updateData.avatar = avatar;

    const user = await User.findByIdAndUpdate(req.userId, updateData, {
      new: true,
      runValidators: true,
    });

    if (!user) {
      throw new NotFoundError('用户不存在');
    }

    successResponse(res, user, '资料更新成功');
  }),

  changePassword: asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      throw new BadRequestError('请输入旧密码和新密码');
    }
    if (newPassword.length < 6) {
      throw new BadRequestError('新密码长度不能少于6位');
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      throw new NotFoundError('用户不存在');
    }

    const isMatch = await user.matchPassword(oldPassword);
    if (!isMatch) {
      throw new BadRequestError('旧密码错误');
    }

    user.password = newPassword;
    await user.save();

    successResponse(res, null, '密码修改成功');
  }),

  deposit: asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      throw new BadRequestError('充值金额必须大于0');
    }

    const result = await TransactionService.deposit(req.userId, amount);

    successResponse(res, {
      transaction: result.transaction,
      newBalance: result.balanceAfter,
    }, `押金充值成功¥${amount}`);
  }),

  getTransactions: asyncHandler(async (req, res) => {
    const { page, pageSize } = getPaginationParams(req.query);
    const options = {
      page,
      pageSize,
      type: req.query.type,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    };

    const result = await TransactionService.getHistory(req.userId, options);
    paginatedResponse(res, result.list, result.pagination.total, page, pageSize);
  }),

  getAllUsers: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.region) filter.region = req.query.region;
    if (req.query.keyword) {
      const keyword = req.query.keyword;
      filter.$or = [
        { username: { $regex: keyword, $options: 'i' } },
        { realName: { $regex: keyword, $options: 'i' } },
        { phone: { $regex: keyword } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
      User.countDocuments(filter),
    ]);

    paginatedResponse(res, users, total, page, pageSize);
  }),

  getUserById: asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) {
      throw new NotFoundError('用户不存在');
    }
    successResponse(res, user);
  }),

  updateUserStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (typeof status !== 'boolean') {
      throw new BadRequestError('状态必须是布尔值');
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      throw new NotFoundError('用户不存在');
    }
    if (user.role === USER_ROLE.ADMIN && !status) {
      throw new BadRequestError('不能禁用管理员账号');
    }

    user.status = status;
    await user.save();

    successResponse(res, user, `用户已${status ? '启用' : '禁用'}`);
  }),

  adjustCreditScore: asyncHandler(async (req, res) => {
    const { delta, reason } = req.body;
    if (!delta || !reason) {
      throw new BadRequestError('请填写分数调整值和原因');
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      throw new NotFoundError('用户不存在');
    }

    const result = await user.updateCreditScore(delta, reason);

    await NotificationService.creditUpdate(
      user._id,
      delta,
      result.newScore,
      reason
    );

    successResponse(res, {
      oldScore: result.oldScore,
      newScore: result.newScore,
      delta: result.delta,
      isRestricted: user.isRentalRestricted,
    }, `信用分已${delta > 0 ? '增加' : '扣除'}${Math.abs(delta)}分`);
  }),

  getUnreadNotifications: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const Notification = require('../models/Notification');

    const [notifications, total] = await Promise.all([
      Notification.find({ recipient: req.userId, isRead: false })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Notification.countDocuments({ recipient: req.userId, isRead: false }),
    ]);

    const unreadCount = await Notification.getUnreadCount(req.userId);

    successResponse(res, {
      list: notifications,
      unreadCount,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }),

  getAllNotifications: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const Notification = require('../models/Notification');
    const filter = { recipient: req.userId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.isRead !== undefined) filter.isRead = req.query.isRead === 'true';

    const [notifications, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      Notification.countDocuments(filter),
    ]);

    const unreadCount = await Notification.getUnreadCount(req.userId);

    paginatedResponse(res, {
      list: notifications,
      unreadCount,
    }, total, page, pageSize);
  }),

  markNotificationRead: asyncHandler(async (req, res) => {
    const Notification = require('../models/Notification');
    const notification = await Notification.findOne({
      _id: req.params.id,
      recipient: req.userId,
    });

    if (!notification) {
      throw new NotFoundError('通知不存在');
    }

    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();

    successResponse(res, notification);
  }),

  markAllNotificationsRead: asyncHandler(async (req, res) => {
    const Notification = require('../models/Notification');
    const result = await Notification.markAllAsRead(req.userId);
    successResponse(res, { modifiedCount: result.nModified || result.modifiedCount || 0 }, '全部标记已读');
  }),

  initAdmin: asyncHandler(async (req, res) => {
    const existingAdmin = await User.findOne({ role: USER_ROLE.ADMIN });
    if (existingAdmin) {
      throw new BadRequestError('管理员已存在');
    }

    const admin = await User.create({
      username: 'admin',
      password: 'admin123',
      realName: '系统管理员',
      phone: '13800000000',
      email: 'admin@example.com',
      region: '朝阳区',
      role: USER_ROLE.ADMIN,
      depositBalance: 10000,
    });

    const token = generateToken(admin._id);
    admin.password = undefined;

    successResponse(res, { user: admin, token }, '管理员初始化成功', 201);
  }),
};

module.exports = userController;
