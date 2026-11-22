/**
 * 生成演示数据（用于本地预览 / 截图）。
 * 用法：node scripts/seed-demo.mjs http://127.0.0.1:8911
 * 注意：会清空目标服务里已有的账户、月报数据，只在测试环境使用。
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8911').replace(/\/+$/, '');

const call = async (path, method = 'GET', body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
  return data;
};

const ACCOUNTS = [
  { name: '招商银行 · 工资卡', kind: 'bank', currency: 'CNY', note: '主要收付账户' },
  { name: '支付宝 · 余额宝', kind: 'alipay', currency: 'CNY', note: '日常零花 + 货基' },
  { name: '微信零钱', kind: 'wechat', currency: 'CNY', note: '' },
  { name: '券商 · 现金理财', kind: 'broker', currency: 'CNY', note: '未买仓位的钱' },
  { name: '汇丰 · 美元活期', kind: 'bank', currency: 'USD', note: '美元备用金' },
];

const MONTHS = [
  { m: '2026-06', cash: [48200, 8600, 1200, 15000, 900], inv: 268000, cost: 255000, liab: 5200, note: '年中，开始记账' },
  { m: '2026-07', cash: [52600, 7400, 980, 15000, 900], inv: 276400, cost: 261000, liab: 4300, note: '工资到账后调整仓位' },
  { m: '2026-08', cash: [44800, 9200, 1560, 18000, 900], inv: 283200, cost: 268000, liab: 6800, note: '旅游支出较多' },
  { m: '2026-09', cash: [57300, 6800, 760, 18000, 1200], inv: 291800, cost: 272000, liab: 3900, note: '季度奖到账' },
  { m: '2026-10', cash: [61500, 7900, 1120, 22000, 1200], inv: 305600, cost: 280000, liab: 5100, note: '加了一笔定投' },
  { m: '2026-11', cash: [63800, 8400, 1350, 22000, 1500], inv: 312400, cost: 285000, liab: 2600, note: '年度体检 + 保险支出' },
];

const run = async () => {
  const existing = await call('/accounts', 'GET');
  for (const a of existing) await call(`/accounts/${a.id}?purge=1`, 'DELETE');
  const old = await call('/months');
  for (const row of old.months) await call(`/snapshot/${row.month}`, 'DELETE');

  const ids = [];
  for (const a of ACCOUNTS) {
    const r = await call('/accounts', 'POST', a);
    ids.push(r.id);
  }

  for (const row of MONTHS) {
    const cash = ids.map((id, i) => ({ accountId: id, balance: row.cash[i] ?? 0 }));
    const liabilities = row.liab
      ? [{ name: '招行信用卡', kind: 'credit', amount: row.liab, currency: 'CNY' }]
      : [];
    await call(`/snapshot/${row.m}`, 'PUT', {
      cash,
      liabilities,
      investment: {
        valueCny: row.inv,
        investedCny: row.cost,
        source: 'manual',
        detail: [
          {
            name: '组合一：稳健核心+科技成长',
            currency: 'USD',
            month: row.m,
            exact: true,
            value: Math.round(row.inv * 0.55) / 7.1,
            invested: Math.round(row.cost * 0.55) / 7.1,
            valueCny: Math.round(row.inv * 0.55),
            investedCny: Math.round(row.cost * 0.55),
          },
          {
            name: '组合二：杠杆成长+黄金对冲',
            currency: 'USD',
            month: row.m,
            exact: true,
            value: Math.round(row.inv * 0.3) / 7.1,
            invested: Math.round(row.cost * 0.3) / 7.1,
            valueCny: Math.round(row.inv * 0.3),
            investedCny: Math.round(row.cost * 0.3),
          },
          {
            name: '组合三：加密多元配置',
            currency: 'USD',
            month: row.m,
            exact: true,
            value: Math.round(row.inv * 0.15) / 7.1,
            invested: Math.round(row.cost * 0.15) / 7.1,
            valueCny: Math.round(row.inv * 0.15),
            investedCny: Math.round(row.cost * 0.15),
          },
        ],
      },
      note: row.note,
      confirmed: true,
    });
  }

  const months = await call('/months');
  console.log(`演示数据已写入 ${BASE}`);
  for (const m of months.months) {
    console.log(`  ${m.month}  现金 ${m.cash}  理财 ${m.invest}  负债 ${m.liabilities}  净资产 ${m.net}`);
  }
};

run().catch((e) => {
  console.error('写入失败：', e.message);
  process.exit(1);
});
