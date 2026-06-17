const { Tool } = require('../models');
const { successResponse, paginatedResponse, BadRequestError, NotFoundError } = require('../utils/response');
const { getPaginationParams, asyncHandler, validateDateRange } = require('../utils/helpers');

const toolController = {
  create: asyncHandler(async (req, res) => {
    const {
      name, description, category, brand, model, images,
      totalStock, deposit, pricing, minRentalPeriod, minRentalUnit,
      maxRentalDays, region, location, usageInstructions, specifications,
    } = req.body;

    if (!name || !category || !totalStock || totalStock < 0 || !deposit || deposit < 0 || !pricing || !pricing.length) {
      throw new BadRequestError('请填写完整的工具信息，包括名称、类别、库存、押金和价格配置');
    }

    const validPeriodTypes = ['hour', 'day', 'week', 'month'];
    for (const p of pricing) {
      if (!validPeriodTypes.includes(p.periodType) || p.price === undefined || p.price < 0) {
        throw new BadRequestError('价格配置格式无效');
      }
    }

    const tool = await Tool.create({
      name, description, category, brand, model, images,
      totalStock, availableStock: totalStock, deposit, pricing,
      minRentalPeriod, minRentalUnit, maxRentalDays,
      region, location, usageInstructions, specifications,
    });

    successResponse(res, tool, '工具创建成功', 201);
  }),

  list: asyncHandler(async (req, res) => {
    const { page, pageSize, skip } = getPaginationParams(req.query);
    const filter = {};

    if (req.query.category) filter.category = req.query.category;
    if (req.query.region) filter.region = req.query.region;
    if (req.query.status !== undefined) filter.status = req.query.status === 'true';
    if (req.query.keyword) {
      const keyword = req.query.keyword;
      filter.$or = [
        { name: { $regex: keyword, $options: 'i' } },
        { description: { $regex: keyword, $options: 'i' } },
        { brand: { $regex: keyword, $options: 'i' } },
        { model: { $regex: keyword, $options: 'i' } },
      ];
    }
    if (req.query.inStockOnly === 'true') {
      filter.availableStock = { $gt: 0 };
    }

    const sort = {};
    if (req.query.sortBy) {
      const order = req.query.sortOrder === 'desc' ? -1 : 1;
      sort[req.query.sortBy] = order;
    } else {
      sort.createdAt = -1;
    }

    const [tools, total] = await Promise.all([
      Tool.find(filter).sort(sort).skip(skip).limit(pageSize),
      Tool.countDocuments(filter),
    ]);

    paginatedResponse(res, tools, total, page, pageSize);
  }),

  getById: asyncHandler(async (req, res) => {
    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }
    successResponse(res, tool);
  }),

  update: asyncHandler(async (req, res) => {
    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }

    const {
      name, description, category, brand, model, images,
      totalStock, deposit, pricing, minRentalPeriod, minRentalUnit,
      maxRentalDays, region, location, status, usageInstructions, specifications,
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (brand !== undefined) updateData.brand = brand;
    if (model !== undefined) updateData.model = model;
    if (images !== undefined) updateData.images = images;
    if (deposit !== undefined) updateData.deposit = deposit;
    if (minRentalPeriod !== undefined) updateData.minRentalPeriod = minRentalPeriod;
    if (minRentalUnit !== undefined) updateData.minRentalUnit = minRentalUnit;
    if (maxRentalDays !== undefined) updateData.maxRentalDays = maxRentalDays;
    if (region !== undefined) updateData.region = region;
    if (location !== undefined) updateData.location = location;
    if (status !== undefined) updateData.status = status;
    if (usageInstructions !== undefined) updateData.usageInstructions = usageInstructions;
    if (specifications !== undefined) updateData.specifications = specifications;
    if (pricing !== undefined) {
      if (!Array.isArray(pricing) || pricing.length === 0) {
        throw new BadRequestError('价格配置不能为空');
      }
      updateData.pricing = pricing;
    }

    if (totalStock !== undefined) {
      if (totalStock < 0) {
        throw new BadRequestError('库存不能为负数');
      }
      updateData.totalStock = totalStock;
      const lockedQty = tool.lockedStock || 0;
      const currentUsed = (tool.totalStock - tool.availableStock - lockedQty);
      const newAvailable = Math.max(0, totalStock - currentUsed - lockedQty);
      updateData.availableStock = newAvailable;
    }

    const updatedTool = await Tool.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    successResponse(res, updatedTool, '工具更新成功');
  }),

  remove: asyncHandler(async (req, res) => {
    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }
    if ((tool.lockedStock || 0) > 0) {
      throw new BadRequestError('该工具有锁定中的订单，无法删除');
    }
    if ((tool.totalStock - (tool.availableStock || 0) - (tool.lockedStock || 0)) > 0) {
      throw new BadRequestError('该工具有未归还的租赁，无法删除');
    }

    await Tool.findByIdAndDelete(req.params.id);
    successResponse(res, null, '工具删除成功');
  }),

  updateStock: asyncHandler(async (req, res) => {
    const { delta, reason } = req.body;
    if (!delta || typeof delta !== 'number') {
      throw new BadRequestError('库存调整值无效');
    }

    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }

    const newTotal = tool.totalStock + delta;
    const lockedQty = tool.lockedStock || 0;
    const currentUsed = tool.totalStock - tool.availableStock - lockedQty;

    if (newTotal < currentUsed + lockedQty) {
      throw new BadRequestError(`库存不足，当前已使用${currentUsed}件，锁定${lockedQty}件`);
    }

    tool.totalStock = newTotal;
    tool.availableStock = Math.max(0, newTotal - currentUsed - lockedQty);
    await tool.save();

    successResponse(res, {
      totalStock: tool.totalStock,
      availableStock: tool.availableStock,
      lockedStock: tool.lockedStock,
    }, `库存已${delta > 0 ? '增加' : '减少'}${Math.abs(delta)}件`);
  }),

  calculatePrice: asyncHandler(async (req, res) => {
    const source = Object.assign({}, req.query, req.body);
    const { startTime, endTime, quantity = 1 } = source;

    if (!startTime || !endTime) {
      throw new BadRequestError('请选择开始时间和结束时间');
    }

    const dateCheck = validateDateRange(startTime, endTime);
    if (!dateCheck.valid) {
      throw new BadRequestError(dateCheck.message);
    }

    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }

    const rent = tool.calculateRent(startTime, endTime);
    const totalRent = rent.totalRent * quantity;
    const totalDeposit = tool.deposit * quantity;
    const durationHours = rent.duration.totalHours;

    if (durationHours < 1) {
      throw new BadRequestError('租期至少1小时');
    }
    if (rent.duration.days > tool.maxRentalDays) {
      throw new BadRequestError(`租期不能超过${tool.maxRentalDays}天`);
    }

    successResponse(res, {
      tool: {
        id: tool._id,
        name: tool.name,
        deposit: tool.deposit,
      },
      quantity,
      startTime,
      endTime,
      duration: rent.duration,
      periodBreakdown: rent.periodBreakdown.map(p => ({
        ...p,
        subtotal: p.subtotal * quantity,
      })),
      rentalFee: totalRent,
      depositRequired: totalDeposit,
      totalAmount: totalRent,
    });
  }),

  checkAvailability: asyncHandler(async (req, res) => {
    const { startTime, endTime, quantity = 1 } = req.query;

    const tool = await Tool.findById(req.params.id);
    if (!tool) {
      throw new NotFoundError('工具不存在');
    }

    if (!tool.status) {
      return successResponse(res, { available: false, reason: '该工具已下架' });
    }

    if ((tool.availableStock || 0) < quantity) {
      return successResponse(res, {
        available: false,
        reason: `库存不足，当前可用${tool.availableStock}件`,
        availableStock: tool.availableStock,
        required: quantity,
      });
    }

    if (startTime && endTime) {
      const dateCheck = validateDateRange(startTime, endTime);
      if (!dateCheck.valid) {
        throw new BadRequestError(dateCheck.message);
      }
      const rent = tool.calculateRent(startTime, endTime);
      if (rent.duration.days > tool.maxRentalDays) {
        return successResponse(res, {
          available: false,
          reason: `租期不能超过${tool.maxRentalDays}天`,
        });
      }
    }

    successResponse(res, {
      available: true,
      availableStock: tool.availableStock,
      lockedStock: tool.lockedStock,
      totalStock: tool.totalStock,
    });
  }),

  getCategoryStats: asyncHandler(async (req, res) => {
    const pipeline = [
      { $match: { status: true } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          totalStock: { $sum: '$totalStock' },
          availableStock: { $sum: '$availableStock' },
          totalRevenue: { $sum: '$totalRevenue' },
          totalUsage: { $sum: '$usageCount' },
          totalDamage: { $sum: '$damageCount' },
        },
      },
      {
        $project: {
          category: '$_id',
          count: 1,
          totalStock: 1,
          availableStock: 1,
          totalRevenue: 1,
          totalUsage: 1,
          totalDamage: 1,
          _id: 0,
        },
      },
      { $sort: { count: -1 } },
    ];

    const stats = await Tool.aggregate(pipeline);
    successResponse(res, stats);
  }),

  bulkCreate: asyncHandler(async (req, res) => {
    const tools = req.body.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new BadRequestError('请提供工具数组');
    }
    if (tools.length > 100) {
      throw new BadRequestError('单次最多创建100个工具');
    }

    const created = await Tool.create(tools);
    successResponse(res, {
      count: created.length,
      tools: created,
    }, `批量创建${created.length}个工具成功`, 201);
  }),
};

module.exports = toolController;
