const successResponse = (res, data = null, message = '操作成功', code = 200) => {
  return res.status(code).json({
    success: true,
    code,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
};

const errorResponse = (res, message = '操作失败', code = 500, errors = null) => {
  const response = {
    success: false,
    code,
    message,
    timestamp: new Date().toISOString(),
  };
  if (errors) {
    response.errors = errors;
  }
  return res.status(code).json(response);
};

const paginatedResponse = (res, data, total, page, pageSize, message = '获取成功') => {
  return res.status(200).json({
    success: true,
    code: 200,
    message,
    data: {
      list: data,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    },
    timestamp: new Date().toISOString(),
  });
};

class AppError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 404);
  }
}

class BadRequestError extends AppError {
  constructor(message = '请求参数错误', errors = null) {
    super(message, 400, errors);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = '未授权，请先登录') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = '权限不足') {
    super(message, 403);
  }
}

class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, 409);
  }
}

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse,
  AppError,
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
};
