/**
 * 生成演示数据（用于本地预览 / 截图）。
 * 用法：node scripts/seed-demo.mjs http://127.0.0.1:8911
 * 注意：会清空目标服务里已有的账户、月报、投资组合，只在测试环境使用。
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

const round = (v) => Math.round(v * 100) / 100;
const USD = 7.1;

const ACCOUNTS = [
  { name: '招商银行 · 工资卡', kind: 'bank', currency: 'CNY', note: '主要收付账户' },
  { name: '支付宝 · 余额宝', kind: 'alipay', currency: 'CNY', note: '日常零花 + 货基' },
  { name: '微信零钱', kind: 'wechat', currency: 'CNY', note: '' },
  { name: '券商 · 现金理财', kind: 'broker', currency: 'CNY', note: '未买仓位的钱' },
  { name: '汇丰 · 美元活期', kind: 'bank', currency: 'USD', note: '美元备用金' },
];

// 组合定义：占比用于把月度总市值拆到各组合
const PORTFOLIOS = [
  { name: '稳健核心 + 科技成长', currency: 'USD', share: 0.55, allocation: 'VOO 40% + QQQ 30% + BND 30%', dcaPlan: '每月 2000 美元' },
  { name: '杠杆成长 + 黄金对冲', currency: 'USD', share: 0.3, allocation: 'TQQQ 50% + GLD 50%', dcaPlan: '每月 800 美元' },
  { name: '加密多元配置', currency: 'USD', share: 0.15, allocation: 'BTC 60% + ETH 40%', dcaPlan: '每月 500 美元' },
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
  // 清空旧数据
  const existing = await call('/accounts', 'GET');
  for (const a of existing) await call(`/accounts/${a.id}?purge=1`, 'DELETE');
  const old = await call('/months');
  for (const row of old.months) await call(`/snapshot/${row.month}`, 'DELETE');
  const oldPf = await call('/portfolios');
  for (const p of oldPf.portfolios || []) await call(`/portfolios/${p.id}?purge=1`, 'DELETE');

  // 固定汇率，让演示数字稳定
  await call('/config', 'PATCH', { fx_source: 'manual', fx_usd_cny: USD, fx_hkd_cny: 0.92 });

  const accountIds = [];
  for (const a of ACCOUNTS) {
    const r = await call('/accounts', 'POST', a);
    accountIds.push(r.id);
  }

  const pfIds = [];
  for (const p of PORTFOLIOS) {
    const r = await call('/portfolios', 'POST', {
      name: p.name,
      currency: p.currency,
      allocation: p.allocation,
      dcaPlan: p.dcaPlan,
    });
    pfIds.push(r.id);
  }

  for (const row of MONTHS) {
    for (let i = 0; i < PORTFOLIOS.length; i += 1) {
      const p = PORTFOLIOS[i];
      await call(`/portfolios/${pfIds[i]}/records`, 'POST', {
        month: row.m,
        invested: round((row.cost * p.share) / USD),
        value: round((row.inv * p.share) / USD),
        note: i === 0 && row.m === '2026-10' ? '定投追加' : '',
      });
    }
    const cash = accountIds.map((id, i) => ({ accountId: id, balance: row.cash[i] ?? 0 }));
    const liabilities = row.liab
      ? [{ name: '招行信用卡', kind: 'credit', amount: row.liab, currency: 'CNY' }]
      : [];
    await call(`/snapshot/${row.m}`, 'PUT', { cash, liabilities, note: row.note, confirmed: true });
  }

  const months = await call('/months');
  const ov = await call('/portfolios');
  console.log(`演示数据已写入 ${BASE}`);
  for (const m of months.months) {
    console.log(`  ${m.month}  现金 ${m.cash}  理财 ${m.invest}  负债 ${m.liabilities}  净资产 ${m.net}`);
  }
  console.log(`  持仓：${ov.portfolios.length} 个组合，市值 ${ov.summary.value}，收益率 ${ov.summary.returnPct}%`);
};

run().catch((e) => {
  console.error('写入失败：', e.message);
  process.exit(1);
});
