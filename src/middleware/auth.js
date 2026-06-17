const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { UnauthorizedError, ForbiddenError } = require('../utils/response');
const { USER_ROLE } = require('../config/constants');

const auth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token && req.cookies) {
      token = req.cookies.token;
    }

    if (!token) {
      throw new UnauthorizedError();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || !user.status) {
      throw new UnauthorizedError('用户不存在或已被禁用');
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return next(new UnauthorizedError('登录已过期，请重新登录'));
    }
    next(error);
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(`需要角色: ${roles.join(', ')}`));
    }
    next();
  };
};

const adminOnly = authorize(USER_ROLE.ADMIN);

const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token && req.cookies) {
      token = req.cookies.token;
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user && user.status) {
        req.user = user;
        req.userId = user._id;
      }
    }
    next();
  } catch (error) {
    next();
  }
};

module.exports = {
  auth,
  authorize,
  adminOnly,
  optionalAuth,
};
