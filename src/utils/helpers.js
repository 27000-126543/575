const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const generateOrderNo = () => {
  const timestamp = Date.now().toString();
  const random = crypto.randomInt(1000, 9999).toString();
  return `ORD${timestamp}${random}`;
};

const generateReportNo = () => {
  const timestamp = Date.now().toString();
  const random = crypto.randomInt(1000, 9999).toString();
  return `RPT${timestamp}${random}`;
};

const generateTransactionNo = () => {
  return `TXN${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
};

const generateToken = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

const paginate = (query, page = 1, pageSize = 10) => {
  const p = Math.max(1, parseInt(page));
  const size = Math.min(100, Math.max(1, parseInt(pageSize)));
  const skip = (p - 1) * size;
  return {
    query: query.skip(skip).limit(size),
    page: p,
    pageSize: size,
    skip,
  };
};

const getPaginationParams = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || 10));
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
};

const formatDate = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
  const d = new Date(date);
  const pad = (n) => n.toString().padStart(2, '0');
  return format
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
};

const getDateRange = (days = 1) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (days > 1) {
    start.setDate(start.getDate() - (days - 1));
  }
  return { start, end };
};

const isSameDay = (date1, date2) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

const parseISODate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
};

const parseDateStartEnd = (startStr, endStr) => {
  const start = parseISODate(startStr);
  const end = parseISODate(endStr);
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);
  return { start, end };
};

const validateDateRange = (startTime, endTime) => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, message: '日期格式无效' };
  }
  if (start >= end) {
    return { valid: false, message: '结束时间必须晚于开始时间' };
  }
  return { valid: true, start, end };
};

const simulateImageComparison = (pickupImages, returnImages) => {
  const seed = (pickupImages.length + returnImages.length) % 10;
  const hasDamage = seed >= 7;
  const confidence = hasDamage ? 70 + Math.floor(Math.random() * 25) : 90 + Math.floor(Math.random() * 9);

  const damages = [];
  if (hasDamage) {
    const damageTypes = [
      { description: '外壳有明显划痕', severity: 'minor', cost: 50 + Math.floor(Math.random() * 100) },
      { description: '边角有碰撞凹陷', severity: 'moderate', cost: 200 + Math.floor(Math.random() * 300) },
      { description: '内部零件损坏', severity: 'severe', cost: 500 + Math.floor(Math.random() * 1000) },
      { description: '电源线磨损断裂', severity: 'moderate', cost: 150 + Math.floor(Math.random() * 150) },
    ];
    const count = 1 + Math.floor(Math.random() * 2);
    const shuffled = damageTypes.sort(() => 0.5 - Math.random()).slice(0, count);
    shuffled.forEach(d => {
      damages.push({
        description: d.description,
        severity: d.severity,
        location: ['正面', '背面', '侧面', '底部'][Math.floor(Math.random() * 4)],
        estimatedCost: d.cost,
      });
    });
  }

  return {
    confidence,
    damageFound: hasDamage,
    damages,
    details: {
      algorithm: 'simulated-cnn-v1',
      processingTime: `${(Math.random() * 2 + 0.5).toFixed(2)}s`,
      imageCount: { pickup: pickupImages.length, returned: returnImages.length },
    },
  };
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const mongoose = require('mongoose');

let transactionSupportCache = null;
const checkTransactionSupport = async () => {
  if (transactionSupportCache !== null) return transactionSupportCache;
  try {
    if (!mongoose.connection || !mongoose.connection.db) {
      transactionSupportCache = false;
      return false;
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      const testCol = collections.find(c => c.name === 'users') || collections[0];
      if (testCol) {
        await mongoose.connection.db.collection(testCol.name).findOne({}, { session });
      }
      await session.abortTransaction();
      transactionSupportCache = true;
    } catch (dbErr) {
      try { await session.abortTransaction(); } catch (_) {}
      console.warn('[Helpers] MongoDB副本集事务不可用（带session操作失败），将以非事务模式运行');
      transactionSupportCache = false;
    } finally {
      try { session.endSession(); } catch (_) {}
    }
  } catch (e) {
    console.warn('[Helpers] MongoDB副本集事务不可用，将以非事务模式运行（建议生产环境使用副本集）');
    transactionSupportCache = false;
  }
  return transactionSupportCache;
};

const withTransaction = async (fn) => {
  const supported = await checkTransactionSupport();
  if (!supported) {
    return await fn({ session: null, useTransaction: false });
  }
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn({ session, useTransaction: true });
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    try { await session.abortTransaction(); } catch (_) {}
    try { session.endSession(); } catch (_) {}
    throw e;
  }
};

const sessionSave = async (doc, session) => {
  if (session) return await doc.save({ session });
  return await doc.save();
};

const sessionCreate = async (Model, data, session) => {
  if (session) {
    const arr = Array.isArray(data) ? data : [data];
    const result = await Model.create(arr, { session });
    return Array.isArray(data) ? result : result[0];
  }
  return Array.isArray(data) ? await Model.create(data) : await Model.create(data);
};

const pick = (obj, keys) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => keys.includes(k))
  );
};

const omit = (obj, keys) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !keys.includes(k))
  );
};

module.exports = {
  generateOrderNo,
  generateReportNo,
  generateTransactionNo,
  generateToken,
  paginate,
  getPaginationParams,
  formatDate,
  getDateRange,
  isSameDay,
  parseISODate,
  parseDateStartEnd,
  validateDateRange,
  simulateImageComparison,
  asyncHandler,
  withTransaction,
  sessionSave,
  sessionCreate,
  pick,
  omit,
};
