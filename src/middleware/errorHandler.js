const { errorResponse, AppError } = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.statusCode = err.statusCode || 500;

  console.error('ERROR:', {
    message: err.message,
    stack: err.stack,
    name: err.name,
    url: req.originalUrl,
    method: req.method,
  });

  if (err.name === 'CastError') {
    const message = `无效的ID格式: ${err.value}`;
    error = new AppError(message, 400);
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {}).join(', ');
    const message = `字段重复: ${field}`;
    error = new AppError(message, 409);
  }

  if (err.name === 'ValidationError') {
    const errors = {};
    Object.values(err.errors).forEach((e) => {
      errors[e.path] = e.message;
    });
    const message = '数据验证失败';
    error = new AppError(message, 400, errors);
  }

  if (err.name === 'SyntaxError' && err.type === 'entity.parse.failed') {
    error = new AppError('JSON格式错误', 400);
  }

  if (err.isJoi) {
    const errors = {};
    err.details.forEach(d => {
      errors[d.path.join('.')] = d.message;
    });
    error = new AppError('参数验证失败', 400, errors);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const response = {
    success: false,
    code: error.statusCode,
    message: error.message || '服务器内部错误',
    timestamp: new Date().toISOString(),
  };

  if (error.errors) {
    response.errors = error.errors;
  }

  if (!isProduction && !error.isOperational) {
    response.stack = err.stack;
  }

  res.status(error.statusCode || 500).json(response);
};

const notFoundHandler = (req, res, next) => {
  const message = `找不到 ${req.method} ${req.originalUrl}`;
  res.status(404).json({
    success: false,
    code: 404,
    message,
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  errorHandler,
  notFoundHandler,
};
