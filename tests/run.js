require('dotenv').config();

const http = require('http');
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = (color, text) => console.log(`${color}${text}${COLORS.reset}`);
const title = (text) => log(COLORS.bold + COLORS.cyan, `\n=== ${text} ===`);
const success = (text) => log(COLORS.green, `  ✓ ${text}`);
const fail = (text) => log(COLORS.red, `  ✗ ${text}`);
const info = (text) => log(COLORS.yellow, `  ℹ ${text}`);

const request = (method, path, body = null, token = null, parseJson = true) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (parseJson && data) {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
          } catch (e) {
            resolve({ status: res.statusCode, body: null, raw: data });
          }
        } else {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = { passed: 0, failed: 0, skipped: 0 };
const test = async (name, fn) => {
  try {
    await fn();
    results.passed++;
    success(name);
    return true;
  } catch (e) {
    results.failed++;
    fail(`${name} - ${e.message}`);
    if (process.env.VERBOSE_TESTS) console.error(e.stack);
    return false;
  }
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'Assertion failed');
};

const assertHttp = (resp, expectedStatus, msg) => {
  if (resp.status !== expectedStatus) {
    const body = typeof resp.body === 'string' ? resp.body.slice(0, 200) : JSON.stringify(resp.body || {}).slice(0, 200);
    throw new Error(`${msg || ''} 期望HTTP ${expectedStatus}，实际${resp.status}。响应: ${body}`);
  }
  if (resp.body && resp.body.success === false) {
    throw new Error(`${msg || ''} 接口返回false: ${resp.body.message}`);
  }
};

const state = {
  adminToken: null,
  adminUser: null,
  userToken: null,
  userId: null,
  toolId: null,
  orderId: null,
  orderNo: null,
  damageReportId: null,
};

const runTests = async () => {
  console.log('\n');
  log(COLORS.bold + COLORS.blue, '╔══════════════════════════════════════════════════════╗');
  log(COLORS.bold + COLORS.blue, '║   社区共享工具租赁平台 - API 集成测试套件              ║');
  log(COLORS.bold + COLORS.blue, '╚══════════════════════════════════════════════════════╝');

  try {
    info(`正在连接服务: ${BASE_URL}`);
    const health = await request('GET', '/health');
    if (health.status !== 200) {
      fail('服务未启动，请先运行 npm start');
      process.exit(1);
    }
    success('服务已启动');
  } catch (e) {
    fail(`无法连接服务: ${e.message}`);
    process.exit(1);
  }

  title('1. 用户模块');

  await test('初始化管理员账号', async () => {
    const r = await request('POST', '/api/users/init-admin');
    if (r.status === 400 && r.body && r.body.message && r.body.message.includes('已存在')) {
      info('管理员已存在，跳过创建');
    } else {
      assertHttp(r, 201);
    }
  });

  await test('管理员登录', async () => {
    const r = await request('POST', '/api/users/login', {
      username: 'admin',
      password: 'admin123',
    });
    assertHttp(r, 200);
    state.adminToken = r.body.data.token;
    state.adminUser = r.body.data.user;
    assert(state.adminToken, '未获取到管理员token');
  });

  let testUsername = 'testuser_' + Date.now();
  let testPhone = '139' + String(Date.now()).slice(-8);

  await test('用户注册', async () => {
    const r = await request('POST', '/api/users/register', {
      username: testUsername,
      password: 'test123456',
      realName: '测试用户',
      phone: testPhone,
      email: 'test@example.com',
      region: '朝阳区',
      address: '测试地址123号',
    });
    assertHttp(r, 201);
    state.userToken = r.body.data.token;
    state.userId = r.body.data.user._id;
  });

  await test('用户登录', async () => {
    const r = await request('POST', '/api/users/login', {
      username: testUsername,
      password: 'test123456',
    });
    assertHttp(r, 200);
    state.userToken = r.body.data.token;
    state.userId = r.body.data.user._id;
  });

  await test('用户押金充值500元', async () => {
    const r = await request('POST', '/api/users/deposit', { amount: 500 }, state.userToken);
    assertHttp(r, 200);
    assert(r.body.data.newBalance === 500, `押金余额不正确: ${r.body.data.newBalance}`);
  });

  await test('获取用户个人资料', async () => {
    const r = await request('GET', '/api/users/profile', null, state.userToken);
    assertHttp(r, 200);
    assert(r.body.data.creditScore >= 60, '信用分过低');
  });

  title('2. 工具管理模块');

  await test('创建工具（管理员）', async () => {
    const r = await request('POST', '/api/tools', {
      name: '博世电钻 GSB 550',
      description: '专业级冲击电钻，适用于混凝土、木材、金属钻孔',
      category: '电动工具',
      brand: '博世',
      model: 'GSB 550',
      totalStock: 10,
      deposit: 200,
      pricing: [
        { periodType: 'hour', price: 5 },
        { periodType: 'day', price: 30 },
        { periodType: 'week', price: 150 },
      ],
      maxRentalDays: 14,
      region: '朝阳区',
      location: '朝阳社区工具站A-01',
      usageInstructions: '请佩戴护目镜使用',
    }, state.adminToken);
    assertHttp(r, 201);
    state.toolId = r.body.data._id;
  });

  await test('获取工具列表（无需登录）', async () => {
    const r = await request('GET', '/api/tools?page=1&pageSize=10');
    assertHttp(r, 200);
  });

  await test('工具租金计算预览', async () => {
    const startTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const endTime = new Date(Date.now() + (3600 * 24 * 2 + 3600 * 5) * 1000).toISOString();
    const r = await request('POST', `/api/tools/${state.toolId}/calculate-price`, {
      startTime, endTime, quantity: 1,
    });
    assertHttp(r, 200);
    assert(r.body.data.rentalFee > 0, '租金计算错误');
  });

  await test('创建更多工具（批量）', async () => {
    const tools = [
      {
        name: '史丹利螺丝刀套装', category: '手动工具', totalStock: 20, deposit: 50,
        pricing: [{ periodType: 'day', price: 5 }, { periodType: 'hour', price: 1 }],
        maxRentalDays: 30, region: '海淀区',
      },
      {
        name: '电动割草机', category: '园艺工具', totalStock: 5, deposit: 500,
        pricing: [{ periodType: 'hour', price: 20 }, { periodType: 'day', price: 100 }],
        maxRentalDays: 7, region: '朝阳区',
      },
    ];
    const r = await request('POST', '/api/tools/bulk', { tools }, state.adminToken);
    assertHttp(r, 201);
  });

  title('3. 租赁申请与订单流程');

  await test('提交租赁申请', async () => {
    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + (3600 * 26) * 1000).toISOString();
    const r = await request('POST', '/api/orders', {
      toolId: state.toolId,
      startTime,
      endTime,
      quantity: 1,
      notes: '用于家庭装修',
    }, state.userToken);
    assertHttp(r, 201);
    state.orderId = r.body.data.order._id;
    state.orderNo = r.body.data.order.orderNo;
    assert(r.body.data.order.status === 'approved', `订单状态异常: ${r.body.data.order.status}`);
  });

  await test('获取我的订单', async () => {
    const r = await request('GET', '/api/orders/mine', null, state.userToken);
    assertHttp(r, 200);
    assert(r.body.data.list.length > 0, '无订单数据');
  });

  await test('用户取用工具（开始计时）', async () => {
    const r = await request('PUT', `/api/orders/${state.orderId}/pickup`, {
      pickupImages: ['/uploads/pickup_test1.jpg', '/uploads/pickup_test2.jpg'],
    }, state.userToken);
    assertHttp(r, 200);
    assert(r.body.data.order.status === 'picked_up', `状态应为picked_up: ${r.body.data.order.status}`);
  });

  await test('用户归还工具（含图像比对）', async () => {
    const returnImages = [
      '/uploads/return_test1.jpg',
      '/uploads/return_test2.jpg',
      '/uploads/return_test3.jpg',
      '/uploads/return_test4.jpg',
      '/uploads/return_test5.jpg',
      '/uploads/return_test6.jpg',
      '/uploads/return_test7.jpg',
    ];
    const r = await request('PUT', `/api/orders/${state.orderId}/return`, {
      returnImages,
    }, state.userToken);
    assertHttp(r, 200);
    info(`图像比对结果: 损坏${r.body.data.comparison.damageFound ? '有' : '无'}, 置信度${r.body.data.comparison.confidence}%`);
    if (r.body.data.damageReport) {
      state.damageReportId = r.body.data.damageReport._id;
      info(`检测到损坏，已生成工单: ${r.body.data.damageReport.reportNo}`);
    }
  });

  await test('创建一个完整无损坏的订单流程', async () => {
    const startTime = new Date(Date.now() + 120 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const r1 = await request('POST', '/api/orders', {
      toolId: state.toolId, startTime, endTime, quantity: 1,
    }, state.userToken);
    const oid = r1.body.data && r1.body.data.order && r1.body.data.order._id;
    if (!oid) return;

    await request('PUT', `/api/orders/${oid}/pickup`, {
      pickupImages: ['/uploads/a.jpg'],
    }, state.userToken);

    await sleep(500);

    await request('PUT', `/api/orders/${oid}/return`, {
      returnImages: ['/uploads/a.jpg', '/uploads/b.jpg'],
    }, state.userToken);
  });

  title('4. 损坏工单管理');

  if (state.damageReportId) {
    await test('获取损坏工单列表', async () => {
      const r = await request('GET', '/api/damages', null, state.adminToken);
      assertHttp(r, 200);
    });

    await test('管理员审核损坏工单', async () => {
      const r = await request('PUT', `/api/damages/${state.damageReportId}/review`, {
        approve: true,
        compensationAmount: 100,
        notes: '经核实确有损坏，赔偿100元',
      }, state.adminToken);
      assertHttp(r, 200);
      assert(r.body.data.approved === true, '审核应通过');
    });
  } else {
    info('未检测到损坏工单（随机结果），跳过审核测试');
    results.skipped++;
  }

  title('5. 通知系统');

  await test('获取通知列表（用户）', async () => {
    const r = await request('GET', '/api/users/notifications', null, state.userToken);
    assertHttp(r, 200);
  });

  await test('获取未读通知数', async () => {
    const r = await request('GET', '/api/users/notifications/unread', null, state.userToken);
    assertHttp(r, 200);
  });

  title('6. 经营报表模块');

  await test('手动生成今日经营报表', async () => {
    const r = await request('POST', '/api/reports/generate-today', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('获取经营仪表盘', async () => {
    const r = await request('GET', '/api/reports/dashboard', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('获取日报表汇总', async () => {
    const today = new Date().toISOString().split('T')[0];
    const r = await request('GET', `/api/reports/summary?startDate=${today}&endDate=${today}`, null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('执行所有定时任务', async () => {
    const r = await request('POST', '/api/reports/run-tasks', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('导出Excel报表', async () => {
    const today = new Date().toISOString().split('T')[0];
    const r = await request(
      'GET',
      `/api/reports/export?startDate=${today}&endDate=${today}`,
      null,
      state.adminToken,
      false
    );
    assert(r.status === 200, `导出失败: HTTP ${r.status}`);
  });

  title('7. 管理员功能');

  await test('获取全部用户列表', async () => {
    const r = await request('GET', '/api/users?page=1&pageSize=20', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('调整用户信用分', async () => {
    const r = await request('PUT', `/api/users/${state.userId}/credit-score`, {
      delta: 5,
      reason: '按时归还奖励',
    }, state.adminToken);
    assertHttp(r, 200);
  });

  await test('获取订单统计', async () => {
    const r = await request('GET', '/api/orders/statistics', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('获取工单统计', async () => {
    const r = await request('GET', '/api/damages/statistics', null, state.adminToken);
    assertHttp(r, 200);
  });

  await test('获取工具分类统计', async () => {
    const r = await request('GET', '/api/tools/category-stats');
    assertHttp(r, 200);
  });

  title('8. 异常场景测试');

  await test('拒绝：押金不足时申请租赁', async () => {
    const poorUser = 'poor_' + Date.now();
    const r1 = await request('POST', '/api/users/register', {
      username: poorUser, password: 'test123456', realName: '穷用户',
      phone: '135' + String(Date.now()).slice(-8), region: '海淀区',
    });
    const tk = r1.body.data && r1.body.data.token;
    if (!tk) throw new Error('注册失败');

    const startTime = new Date(Date.now() + 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const r2 = await request('POST', '/api/orders', {
      toolId: state.toolId, startTime, endTime,
    }, tk);
    assert(r2.body.data.rejected === true, '应该因押金不足拒绝');
  });

  await test('拒绝：信用分不足时申请租赁（模拟）', async () => {
    const lowUser = 'low_' + Date.now();
    const r1 = await request('POST', '/api/users/register', {
      username: lowUser, password: 'test123456', realName: '低信用',
      phone: '136' + String(Date.now()).slice(-8), region: '丰台区',
    });
    const uid = r1.body.data.user._id;
    const tk = r1.body.data.token;

    await request('PUT', `/api/users/${uid}/credit-score`, {
      delta: -60, reason: '测试用：降信用',
    }, state.adminToken);

    await request('POST', '/api/users/deposit', { amount: 1000 }, tk);

    const startTime = new Date(Date.now() + 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const r2 = await request('POST', '/api/orders', {
      toolId: state.toolId, startTime, endTime,
    }, tk);
    assert(r2.body.data.rejected === true, '应该因权限不足拒绝');
    const reason = r2.body.data.reason || '';
    const validReason = reason.includes('信用分') || reason.includes('限制') || reason.includes('押金');
    assert(validReason, `拒绝原因不符合预期: ${reason}`);
  });

  title('9. 业务规则回归测试');

  await test('一笔逾期不限制租赁（真实定时检查路径）', async () => {
    const ovUser1 = 'ov1_' + Date.now();
    const reg1 = await request('POST', '/api/users/register', {
      username: ovUser1, password: 'test123456', realName: '逾期测试1',
      phone: '137' + String(Date.now()).slice(-8), region: '东城区',
    });
    const tk1 = reg1.body.data.token;
    const uid1 = reg1.body.data.user._id;
    await request('POST', '/api/users/deposit', { amount: 2000 }, tk1);

    const profileBefore = await request('GET', '/api/users/profile', null, tk1);
    const creditBefore = profileBefore.body.data.creditScore;
    const consecutiveBefore = profileBefore.body.data.consecutiveOverdue || 0;

    const startTime = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const endTime = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    const order1 = await request('POST', '/api/orders', {
      toolId: state.toolId, startTime, endTime,
    }, tk1);
    assertHttp(order1, 201);
    const oid1 = order1.body.data.order._id;

    await request('PUT', `/api/orders/${oid1}/pickup`, {
      pickupImages: ['p1.jpg'],
    }, tk1);

    const runR = await request('POST', '/api/reports/run-tasks', null, state.adminToken);
    assertHttp(runR, 200);
    info(`定时任务逾期处理: ${JSON.stringify(runR.body.data.overdue)}`);

    const profileAfter = await request('GET', '/api/users/profile', null, tk1);
    const creditAfter = profileAfter.body.data.creditScore;
    const consecutiveAfter = profileAfter.body.data.consecutiveOverdue || 0;

    assert(creditAfter < creditBefore,
      `逾期后信用分应下降: 之前${creditBefore} 之后${creditAfter}`);
    assert(consecutiveAfter === consecutiveBefore + 1,
      `连续逾期次数应+1: 之前${consecutiveBefore} 之后${consecutiveAfter}`);
    assert(profileAfter.body.data.isRentalRestricted !== true,
      '一笔逾期不应触发 isRentalRestricted 限制');
    info(`信用分变化: ${creditBefore}→${creditAfter}，连续逾期: ${consecutiveAfter}，未被限制`);

    const notifR = await request('GET', '/api/users/notifications', null, tk1);
    const notifData = notifR.body.data || {};
    const notifList = (notifData.list && notifData.list.list) ? notifData.list.list : (notifData.list || []);
    assert(notifList.length > 0, '逾期后应产生通知');
    info(`通知数量: ${notifList.length}`);

    const creditAdjustR = await request('PUT', `/api/users/${uid1}/credit-score`, {
      delta: 20, reason: '管理员手动奖励，不应触发连续逾期限制',
    }, state.adminToken);
    assertHttp(creditAdjustR, 200);

    const profileAdj = await request('GET', '/api/users/profile', null, tk1);
    assert(profileAdj.body.data.isRentalRestricted !== true,
      '管理员手动调整信用分也不应触发租赁限制');

    const s2 = new Date(Date.now() + 1000).toISOString();
    const e2 = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const retry = await request('POST', '/api/orders', {
      toolId: state.toolId, startTime: s2, endTime: e2,
    }, tk1);

    if (retry.body.data && retry.body.data.rejected === true) {
      const reason = retry.body.data.reason || '';
      assert(!reason.includes('限制'),
        `一笔逾期后申请不应因租赁限制被拒: ${reason}`);
    } else {
      assertHttp(retry, 201);
      info('一笔逾期后可以正常提交新申请');
    }
  });

  await test('两笔不同订单逾期才限制租赁（真实定时检查路径）', async () => {
    const ovUser2 = 'ov2_' + Date.now();
    const reg2 = await request('POST', '/api/users/register', {
      username: ovUser2, password: 'test123456', realName: '逾期测试2',
      phone: '138' + String(Date.now()).slice(-8), region: '西城区',
    });
    const tk2 = reg2.body.data.token;
    await request('POST', '/api/users/deposit', { amount: 5000 }, tk2);

    const tools = await request('GET', '/api/tools', null, tk2);
    const toolList = tools.body.data && tools.body.data.list ? tools.body.data.list : [];
    const tid1 = state.toolId;
    let tid2 = tid1;
    if (toolList.length > 1) {
      tid2 = toolList.find(t => t._id !== tid1)?._id || tid1;
    }

    const s1 = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const e1 = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const o1 = await request('POST', '/api/orders', { toolId: tid1, startTime: s1, endTime: e1 }, tk2);
    assertHttp(o1, 201);
    const oid1 = o1.body.data.order._id;
    await request('PUT', `/api/orders/${oid1}/pickup`, { pickupImages: ['p1.jpg'] }, tk2);

    const run1 = await request('POST', '/api/reports/run-tasks', null, state.adminToken);
    assertHttp(run1, 200);
    info(`第一笔逾期扫到: ${JSON.stringify(run1.body.data.overdue)}`);

    const prof1 = await request('GET', '/api/users/profile', null, tk2);
    assert(prof1.body.data.consecutiveOverdue === 1,
      `第一笔后连续逾期应为1，实际${prof1.body.data.consecutiveOverdue}`);
    assert(prof1.body.data.isRentalRestricted !== true,
      '第一笔逾期后不应被限制');

    const s2 = new Date(Date.now() + 1000).toISOString();
    const e2 = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const applyAfter1 = await request('POST', '/api/orders', { toolId: tid1, startTime: s2, endTime: e2 }, tk2);
    if (applyAfter1.body.data && applyAfter1.body.data.rejected === true) {
      const reason = applyAfter1.body.data.reason || '';
      assert(!reason.includes('限制'),
        `第一笔逾期后申请不应因限制被拒: ${reason}`);
    } else {
      assertHttp(applyAfter1, 201);
    }
    info('第一笔逾期后，仍可正常提交新申请');

    const s3 = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const e3 = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    const o2 = await request('POST', '/api/orders', { toolId: tid2, startTime: s3, endTime: e3 }, tk2);
    assertHttp(o2, 201);
    const oid2 = o2.body.data.order._id;
    await request('PUT', `/api/orders/${oid2}/pickup`, { pickupImages: ['p2.jpg'] }, tk2);

    const run2 = await request('POST', '/api/reports/run-tasks', null, state.adminToken);
    assertHttp(run2, 200);
    info(`第二笔逾期扫到: ${JSON.stringify(run2.body.data.overdue)}`);

    const prof2 = await request('GET', '/api/users/profile', null, tk2);
    assert(prof2.body.data.consecutiveOverdue >= 2,
      `第二笔后连续逾期应>=2，实际${prof2.body.data.consecutiveOverdue}`);
    assert(prof2.body.data.isRentalRestricted === true,
      `两笔不同订单逾期后应被限制 isRentalRestricted=true，实际${prof2.body.data.isRentalRestricted}`);
    info('两笔不同订单逾期后，用户已被自动限制租赁');

    const s4 = new Date(Date.now() + 1000).toISOString();
    const e4 = new Date(Date.now() + 3600 * 1000).toISOString();
    const rejectR = await request('POST', '/api/orders', { toolId: tid1, startTime: s4, endTime: e4 }, tk2);
    const reason = (rejectR.body.data && rejectR.body.data.reason) || '';
    assert(reason.includes('限制'),
      `两笔逾期后申请应被限制，原因应包含'限制'，实际: ${reason}`);
    info(`两笔逾期后申请被正确拒绝: ${reason}`);
  });

  await test('多订单冻结押金：赔偿只能扣/释放当前订单相关押金', async () => {
    const compUser = 'multi_' + Date.now();
    const reg3 = await request('POST', '/api/users/register', {
      username: compUser, password: 'test123456', realName: '多单冻结测试',
      phone: '151' + String(Date.now()).slice(-8), region: '朝阳区',
    });
    const tk3 = reg3.body.data.token;
    await request('POST', '/api/users/deposit', { amount: 1000 }, tk3);

    const tools = await request('GET', '/api/tools', null, state.adminToken);
    const toolList = tools.body.data && tools.body.data.list ? tools.body.data.list : [];
    assert(toolList.length >= 2, '需要至少2个工具来同时租');
    const toolA = toolList[0];
    const toolB = toolList.find(t => t._id !== toolA._id) || toolList[1];
    const depositA = toolA.deposit || 200;
    const depositB = toolB.deposit || 200;

    const sa = new Date(Date.now() + 1000).toISOString();
    const ea = new Date(Date.now() + 3600 * 1000).toISOString();
    const orderA = await request('POST', '/api/orders', {
      toolId: toolA._id, startTime: sa, endTime: ea,
    }, tk3);
    assertHttp(orderA, 201);
    const oidA = orderA.body.data.order._id;

    const sb = new Date(Date.now() + 2000).toISOString();
    const eb = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const orderB = await request('POST', '/api/orders', {
      toolId: toolB._id, startTime: sb, endTime: eb,
    }, tk3);
    assertHttp(orderB, 201);
    const oidB = orderB.body.data.order._id;

    await request('PUT', `/api/orders/${oidA}/pickup`, { pickupImages: ['pa.jpg'] }, tk3);
    await request('PUT', `/api/orders/${oidB}/pickup`, { pickupImages: ['pb.jpg'] }, tk3);

    const profBefore = await request('GET', '/api/users/profile', null, tk3);
    const balanceBefore = profBefore.body.data.depositBalance;
    const frozenBefore = profBefore.body.data.frozenDeposit;
    info(`两单取用后: 余额¥${balanceBefore}, 冻结¥${frozenBefore}`);
    assert(frozenBefore >= depositA + depositB - 10,
      `冻结金额应约等于两单押金之和(${depositA}+${depositB})，实际¥${frozenBefore}`);

    const retA = await request('PUT', `/api/orders/${oidA}/return`, {
      returnImages: ['ra1.jpg','ra2.jpg','ra3.jpg','ra4.jpg','ra5.jpg','ra6.jpg','ra7.jpg'],
    }, tk3);
    assertHttp(retA, 200);

    if (retA.body.data.damageReport) {
      const drId = retA.body.data.damageReport._id || retA.body.data.damageReport;
      info(`订单A损坏工单: ${drId}`);

      const compensationAmount = 100;
      const reviewR = await request('PUT', `/api/damages/${drId}/review`, {
        approve: true,
        compensationAmount,
        notes: '测试多单冻结赔偿',
      }, state.adminToken);
      assertHttp(reviewR, 200);

      const profAfter = await request('GET', '/api/users/profile', null, tk3);
      const balanceAfter = profAfter.body.data.depositBalance;
      const frozenAfter = profAfter.body.data.frozenDeposit;
      info(`订单A赔偿后: 余额¥${balanceAfter}, 冻结¥${frozenAfter}`);

      if (reviewR.body.data.payment && reviewR.body.data.payment.paid) {
        assert(balanceAfter === balanceBefore - compensationAmount,
          `赔偿后余额应减少¥${compensationAmount}: 之前¥${balanceBefore} 之后¥${balanceAfter}`);

        const expectedFrozen = depositB;
        assert(Math.abs(frozenAfter - expectedFrozen) <= 1,
          `赔偿后冻结应只剩订单B的押金¥${expectedFrozen}，实际¥${frozenAfter}`);
        info(`✓ 订单B的冻结押金保持¥${frozenAfter}未被误动`);

        const txnR = await request('GET', '/api/users/transactions', null, tk3);
        const txnList = txnR.body.data && txnR.body.data.list ? txnR.body.data.list : [];
        const compTxn = txnList.find(t => t.type === 'compensation');
        assert(compTxn, '应有赔偿交易流水');
        assert(typeof compTxn.frozenBefore === 'number' && typeof compTxn.frozenAfter === 'number',
          '赔偿流水应包含冻结前后金额');
        assert(compTxn.fromFrozen >= 0,
          `赔偿流水应记录从冻结扣款金额 fromFrozen=${compTxn.fromFrozen}`);
        info(`✓ 交易流水: 冻结前¥${compTxn.frozenBefore}→冻结后¥${compTxn.frozenAfter}, 从冻结扣¥${compTxn.fromFrozen}`);
      }
    } else {
      info('订单A未触发损坏（随机），跳过该断言');
    }
  });

  await test('赔偿金额超余额不标已赔偿 + 充值后重试成功（多订单冻结场景）', async () => {
    const expUser = 'exp2_' + Date.now();
    const reg4 = await request('POST', '/api/users/register', {
      username: expUser, password: 'test123456', realName: '超额赔偿重试',
      phone: '152' + String(Date.now()).slice(-8), region: '海淀区',
    });
    const tk4 = reg4.body.data.token;

    const tools = await request('GET', '/api/tools', null, state.adminToken);
    const toolList = tools.body.data && tools.body.data.list ? tools.body.data.list : [];
    assert(toolList.length >= 2, '需要至少2个工具');
    const toolA = toolList[0];
    const toolB = toolList.find(t => t._id !== toolA._id) || toolList[1];
    const depositA = toolA.deposit || 200;
    const depositB = toolB.deposit || 200;

    await request('POST', '/api/users/deposit', { amount: depositA + depositB + 50 }, tk4);

    const sa = new Date(Date.now() + 1000).toISOString();
    const ea = new Date(Date.now() + 3600 * 1000).toISOString();
    const orderA = await request('POST', '/api/orders', {
      toolId: toolA._id, startTime: sa, endTime: ea,
    }, tk4);
    assertHttp(orderA, 201);
    const oidA = orderA.body.data.order._id;

    const sb = new Date(Date.now() + 2000).toISOString();
    const eb = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const orderB = await request('POST', '/api/orders', {
      toolId: toolB._id, startTime: sb, endTime: eb,
    }, tk4);
    assertHttp(orderB, 201);
    const oidB = orderB.body.data.order._id;

    await request('PUT', `/api/orders/${oidA}/pickup`, { pickupImages: ['pa.jpg'] }, tk4);
    await request('PUT', `/api/orders/${oidB}/pickup`, { pickupImages: ['pb.jpg'] }, tk4);

    const profBefore = await request('GET', '/api/users/profile', null, tk4);
    const frozenBefore = profBefore.body.data.frozenDeposit;
    info(`赔偿前冻结: ¥${frozenBefore}（应包含订单A和B的押金）`);

    const retA = await request('PUT', `/api/orders/${oidA}/return`, {
      returnImages: ['ra1.jpg','ra2.jpg','ra3.jpg','ra4.jpg','ra5.jpg','ra6.jpg','ra7.jpg'],
    }, tk4);
    assertHttp(retA, 200);

    if (retA.body.data.damageReport) {
      const drId = retA.body.data.damageReport._id || retA.body.data.damageReport;

      const profPre = await request('GET', '/api/users/profile', null, tk4);
      const availablePre = profPre.body.data.depositBalance - profPre.body.data.frozenDeposit;
      const hugeAmount = Math.max(1000, (profPre.body.data.depositBalance || 0) + 1000);

      const reviewR = await request('PUT', `/api/damages/${drId}/review`, {
        approve: true,
        compensationAmount: hugeAmount,
        notes: '测试超额赔偿（多单冻结）',
      }, state.adminToken);

      const drStatus = reviewR.body.data.report && reviewR.body.data.report.status;
      const paymentInfo = reviewR.body.data.payment || {};

      if (paymentInfo.failed) {
        assert(drStatus !== 'compensated',
          `超额赔偿不应标记已赔偿，状态: ${drStatus}`);
        assert(drStatus === 'payment_failed' || drStatus === 'pending_payment',
          `应保留待支付或失败状态，当前: ${drStatus}`);
        info(`超额赔偿正确保留状态: ${drStatus}`);

        const profFail = await request('GET', '/api/users/profile', null, tk4);
        const frozenFail = profFail.body.data.frozenDeposit;
        assert(Math.abs(frozenFail - frozenBefore) <= 1,
          `扣款失败后冻结金额不应变化: 之前¥${frozenBefore} 之后¥${frozenFail}`);
        info('✓ 扣款失败后，订单A和订单B的冻结押金都未被误动');
      }

      const payRetry = await request('PUT', `/api/damages/${drId}/pay`, {}, tk4);
      if (payRetry.body.data.payment && payRetry.body.data.payment.failed) {
        assert(payRetry.body.data.report.status !== 'compensated',
          '余额不足时重试也不应标记已赔偿');
        const msg = payRetry.body.data.payment.message || payRetry.body.data.message || '';
        assert(msg.includes('余额不足') || msg.includes('押金余额不足'),
          `应返回明确的余额不足信息: ${msg}`);
        info(`重试扣款正确保留失败状态，余额不足信息: ${msg}`);

        const profRetryFail = await request('GET', '/api/users/profile', null, tk4);
        assert(Math.abs(profRetryFail.body.data.frozenDeposit - frozenBefore) <= 1,
          '重试失败也不能误动冻结押金');
      }

      await request('POST', '/api/users/deposit', { amount: 100000 }, tk4);

      const payRetry2 = await request('PUT', `/api/damages/${drId}/pay`, {}, tk4);
      if (payRetry2.body.data.payment && payRetry2.body.data.payment.paid) {
        assert(payRetry2.body.data.report.status === 'compensated',
          '充值后重试应成功并标记已赔偿');

        const profAfter = await request('GET', '/api/users/profile', null, tk4);
        const frozenAfter = profAfter.body.data.frozenDeposit;
        assert(Math.abs(frozenAfter - depositB) <= 1,
          `充值后重试成功，应只释放订单A的冻结，订单B冻结¥${depositB}仍保留，实际¥${frozenAfter}`);
        info(`✓ 充值后重试成功: 订单B的冻结押金仍为¥${frozenAfter}，未被误动`);
      }
    } else {
      info('订单A未触发损坏（随机），跳过该断言');
    }
  });

  console.log('\n');
  log(COLORS.bold, '══════════════════════════════════════════════════════');
  log(COLORS.bold + COLORS.green, `  通过: ${results.passed}`);
  log(results.failed > 0 ? COLORS.bold + COLORS.red : COLORS.bold, `  失败: ${results.failed}`);
  log(COLORS.bold + COLORS.yellow, `  跳过: ${results.skipped}`);
  log(COLORS.bold, '══════════════════════════════════════════════════════');

  process.exit(results.failed > 0 ? 1 : 0);
};

runTests().catch(e => {
  console.error(COLORS.red, '测试运行异常:', e);
  process.exit(1);
});
