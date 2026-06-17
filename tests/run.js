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
