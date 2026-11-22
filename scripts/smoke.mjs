/**
 * 无依赖冒烟测试：起一个临时实例，走完「建账户 → 录月报 → 汇总 → 同步报错 → 删除」全流程。
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.SMOKE_PORT) || 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-smoke-'));
const PASSWORD = 'ci-pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label} ${extra}`);
  }
};

let cookie = '';
const call = async (p, method = 'GET', body) => {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const main = async () => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, AUTH_PASSWORD: PASSWORD, PORTFOLIO_MODE: 'manual' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));

  try {
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        /* 还在启动 */
      }
      await sleep(250);
    }
    if (!ready) throw new Error('服务未能在 10 秒内启动');

    console.log('健康检查');
    const health = await call('/health');
    ok('健康检查返回 ok', health.data.ok === true);

    console.log('鉴权');
    const denied = await call('/accounts');
    ok('未登录访问业务接口返回 401', denied.status === 401, `实际 ${denied.status}`);
    const badLogin = await call('/login', 'POST', { password: 'wrong' });
    ok('错误密码返回 401', badLogin.status === 401);
    const login = await call('/login', 'POST', { password: PASSWORD });
    ok('正确密码登录成功', login.status === 200 && login.data.ok === true);

    console.log('固定汇率，便于校验数值');
    await call('/config', 'PATCH', { fx_source: 'manual', fx_usd_cny: 7, fx_hkd_cny: 0.9 });

    console.log('账户');
    const cny = await call('/accounts', 'POST', { name: '招行储蓄卡', kind: 'bank' });
    const usd = await call('/accounts', 'POST', { name: '美元活期', kind: 'bank', currency: 'USD' });
    ok('创建两个账户', cny.status === 201 && usd.status === 201);

    console.log('月报写入');
    const put1 = await call('/snapshot/2026-01', 'PUT', {
      cash: [
        { accountId: cny.data.id, balance: 10000 },
        { accountId: usd.data.id, balance: 1000 },
      ],
      liabilities: [{ name: '信用卡', kind: 'credit', amount: 2000, currency: 'CNY' }],
      investment: { valueCny: 5000, investedCny: 4800, source: 'manual' },
      note: '冒烟测试',
      confirmed: true,
    });
    ok('写入 1 月月报', put1.status === 200);
    const t1 = put1.data.totals;
    ok('现金 = 10000 + 1000×7 = 17000', t1.cash === 17000, `实际 ${t1.cash}`);
    ok('总资产 = 17000 + 5000 = 22000', t1.assets === 22000, `实际 ${t1.assets}`);
    ok('净资产 = 22000 − 2000 = 20000', t1.net === 20000, `实际 ${t1.net}`);
    ok('理财收益率 = 4.17%', t1.investReturnPct === 4.17, `实际 ${t1.investReturnPct}`);

    console.log('第二个月与环比');
    const put2 = await call('/snapshot/2026-02', 'PUT', {
      cash: [
        { accountId: cny.data.id, balance: 12000 },
        { accountId: usd.data.id, balance: 1000 },
      ],
      liabilities: [],
      investment: { valueCny: 5600, investedCny: 5000, source: 'manual' },
    });
    ok('环比净资产 = 24600 − 20000', put2.data.change.net === 4600, `实际 ${put2.data.change.net}`);

    const carry = await call('/snapshot/2026-03');
    ok(
      '新月份自动带出上月余额（标记为沿用）',
      carry.data.cash[0].carried === true && carry.data.cash[0].balance === 12000,
      JSON.stringify(carry.data.cash[0]),
    );

    console.log('趋势与月份');
    const trend = await call('/trend');
    ok('趋势返回 2 个月', trend.data.trend.length === 2, `实际 ${trend.data.trend.length}`);
    const months = await call('/months');
    ok('月份列表按升序', months.data.months.map((m) => m.month).join(',') === '2026-01,2026-02');

    console.log('理财同步：手动模式下应报错');
    const sync = await call('/snapshot/2026-02/sync', 'POST');
    ok('手动模式同步返回 400', sync.status === 400, `实际 ${sync.status}`);

    console.log('接口校验');
    const badMonth = await call('/snapshot/2026-13');
    ok('非法月份返回 400', badMonth.status === 400);
    const badAcc = await call('/accounts', 'POST', { name: '  ' });
    ok('空账户名返回 400', badAcc.status === 400);

    console.log('备份');
    const exp = await call('/export');
    ok('导出包含 2 条月度余额 × 2 账户', exp.data.entries.length === 4, `实际 ${exp.data.entries.length}`);
    const imp = await call('/import', 'POST', { data: exp.data, mode: 'merge' });
    ok('导入备份成功', imp.status === 200 && imp.data.entries === 4);

    console.log('删除月份');
    const del = await call('/snapshot/2026-01', 'DELETE');
    const after = await call('/months');
    ok('删除后仅剩 1 个月', del.status === 200 && after.data.months.length === 1);

    console.log('静态页面');
    const page = await fetch(`${BASE}/`, { headers: { Cookie: cookie, Accept: 'text/html' } });
    ok('首页返回 200', page.status === 200);
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
};

main().catch((e) => {
  console.error('冒烟测试异常：', e.message);
  process.exit(1);
});
