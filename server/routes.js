import { Router } from 'express';
import { db, getConfig, setSettings } from './db.js';
import { fetchFx, round2 } from './fx.js';
import {
  CURRENCIES,
  isMonth,
  getPortfolio,
  deletePortfolioRecords,
  investmentForMonth,
  portfolioOverview,
  cacheInvestment,
  upsertRecord,
  portfolioMonths,
  todayMonth,
} from './portfolio.js';

export const api = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KINDS = ['bank', 'alipay', 'wechat', 'cash', 'broker', 'other'];
const LIAB_KINDS = ['credit', 'loan', 'borrow', 'other'];

/* ---------------- 基础工具 ---------------- */

const getSnapshotRow = (month) => db.prepare('SELECT * FROM snapshots WHERE month = ?').get(month);
const getInvestmentRow = (month) => {
  const row = db.prepare('SELECT * FROM investments WHERE month = ?').get(month);
  if (!row) return null;
  let detail = [];
  try {
    detail = JSON.parse(row.detail || '[]');
  } catch {
    detail = [];
  }
  return { ...row, detail };
};

/** 某月使用的汇率（优先用该月保存时的汇率，保证历史不漂移） */
function fxFor(month, cfg) {
  const snap = getSnapshotRow(month);
  const usd = Number(snap?.fx_usd) || cfg.fx_usd_cny;
  const hkd = Number(snap?.fx_hkd) || cfg.fx_hkd_cny;
  return { usd, hkd, toCny: (cur) => (cur === 'USD' ? usd : cur === 'HKD' ? hkd : 1) };
}

/**
 * 某月的理财市值。
 * 优先级：内置持仓记录（自动算出）> 该月手动/历史缓存值 > 0
 */
function investmentOf(month, fx) {
  const auto = investmentForMonth(month, fx);
  if (auto.detail.length) return { ...auto, manual: false };
  const row = getInvestmentRow(month);
  if (row) {
    return {
      source: 'manual',
      hasPortfolios: auto.hasPortfolios,
      valueCny: round2(row.value_cny),
      investedCny: round2(row.invested_cny),
      detail: row.detail,
      partial: false,
      warnings: auto.warnings,
      manual: true,
      syncedAt: row.synced_at,
      note: row.note || '',
    };
  }
  return { ...auto, manual: false };
}

/** 某月的全部汇总 */
function monthTotals(month, cfg = getConfig()) {
  const fx = fxFor(month, cfg);
  const cashRows = db
    .prepare(`SELECT e.balance, a.currency FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.month = ?`)
    .all(month);
  const cash = round2(cashRows.reduce((s, r) => s + num(r.balance) * fx.toCny(r.currency), 0));

  const liabRows = db.prepare('SELECT amount, currency FROM liabilities WHERE month = ?').all(month);
  const liabilities = round2(liabRows.reduce((s, r) => s + num(r.amount) * fx.toCny(r.currency), 0));

  const inv = investmentOf(month, fx);
  const invest = round2(inv.valueCny || 0);
  const investInvested = round2(inv.investedCny || 0);
  const assets = round2(cash + invest);
  const net = round2(assets - liabilities);

  return {
    month,
    cash,
    invest,
    investInvested,
    investGain: round2(invest - investInvested),
    investReturnPct: investInvested > 0 ? round2(((invest - investInvested) / investInvested) * 100) : null,
    assets,
    liabilities,
    net,
    cashShare: assets > 0 ? round2((cash / assets) * 100) : null,
    investShare: assets > 0 ? round2((invest / assets) * 100) : null,
    liabilityRatio: assets > 0 ? round2((liabilities / assets) * 100) : null,
    hasInvestment: Boolean(inv.detail.length || inv.manual),
  };
}

/** 所有出现过的月份（升序） */
function allMonths() {
  const rows = db
    .prepare(
      `SELECT month FROM snapshots
       UNION SELECT month FROM entries
       UNION SELECT month FROM liabilities
       UNION SELECT month FROM investments
       ORDER BY month`,
    )
    .all();
  return rows.map((r) => r.month).filter(isMonth);
}

const prevMonthOf = (month) => {
  const list = allMonths().filter((m) => m < month);
  return list.length ? list[list.length - 1] : null;
};

function withChange(cur, prev) {
  const mk = (k) => (prev ? round2(cur[k] - prev[k]) : null);
  const base = prev ? round2(cur.net - prev.net) : null;
  const basePrev = prev ? prev.net : 0;
  return {
    net: base,
    netPct: prev && Math.abs(basePrev) > 0.004 ? round2((base / Math.abs(basePrev)) * 100) : null,
    cash: mk('cash'),
    invest: mk('invest'),
    assets: mk('assets'),
    liabilities: mk('liabilities'),
  };
}

/* ---------------- 健康检查 ---------------- */

api.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, service: 'monthly-balance-sheet', db: 'ok', uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ ok: false, service: 'monthly-balance-sheet', db: 'error', error: e.message });
  }
});

/* ---------------- 现金账户（位置） ---------------- */

function accountList({ includeArchived = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM accounts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort_order, id`)
    .all();
  const latest = db
    .prepare(
      `SELECT e.account_id, e.month, e.balance FROM entries e
       JOIN (SELECT account_id, MAX(month) AS m FROM entries GROUP BY account_id) t
         ON t.account_id = e.account_id AND t.m = e.month`,
    )
    .all();
  const map = new Map(latest.map((r) => [r.account_id, r]));
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    currency: a.currency,
    sortOrder: a.sort_order,
    archived: Boolean(a.archived),
    note: a.note || '',
    latest: map.get(a.id) ? { month: map.get(a.id).month, balance: round2(map.get(a.id).balance) } : null,
  }));
}

api.get('/accounts', wrap(async (req, res) => {
  res.json(accountList({ includeArchived: req.query.archived === '1' }));
}));

api.post('/accounts', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw fail('账户名称不能为空');
  if (name.length > 40) throw fail('账户名称过长（最多 40 字）');
  const kind = KINDS.includes(b.kind) ? b.kind : 'bank';
  const currency = CURRENCIES.includes(b.currency) ? b.currency : 'CNY';
  const sortOrder = num(b.sortOrder, 0) || 0;
  const info = db
    .prepare('INSERT INTO accounts (name, kind, currency, sort_order, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, kind, currency, sortOrder, String(b.note || '').slice(0, 100), new Date().toISOString());
  res.status(201).json({ ok: true, id: info.lastInsertRowid, accounts: accountList() });
}));

api.patch('/accounts/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!a) throw fail('账户不存在', 404);
  const b = req.body || {};
  const name = b.name === undefined ? a.name : String(b.name || '').trim();
  if (!name) throw fail('账户名称不能为空');
  db.prepare('UPDATE accounts SET name = ?, kind = ?, currency = ?, sort_order = ?, archived = ?, note = ? WHERE id = ?').run(
    name.slice(0, 40),
    b.kind === undefined ? a.kind : KINDS.includes(b.kind) ? b.kind : a.kind,
    b.currency === undefined ? a.currency : CURRENCIES.includes(b.currency) ? b.currency : a.currency,
    b.sortOrder === undefined ? a.sort_order : num(b.sortOrder, 0),
    b.archived === undefined ? a.archived : b.archived ? 1 : 0,
    b.note === undefined ? a.note : String(b.note || '').slice(0, 100),
    id,
  );
  res.json({ ok: true, accounts: accountList() });
}));

api.delete('/accounts/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!a) throw fail('账户不存在', 404);
  if (req.query.purge === '1') {
    db.prepare('DELETE FROM entries WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return res.json({ ok: true, purged: true, accounts: accountList() });
  }
  db.prepare('UPDATE accounts SET archived = 1 WHERE id = ?').run(id);
  res.json({ ok: true, archived: true, accounts: accountList() });
}));

/* ---------------- 投资组合（内置持仓管理） ---------------- */

const pfPayload = (b, base = {}) => ({
  name: b.name === undefined ? base.name : String(b.name || '').trim(),
  allocation: b.allocation === undefined ? base.allocation || '' : String(b.allocation || '').slice(0, 200),
  dcaPlan: b.dcaPlan === undefined ? base.dcaPlan || '' : String(b.dcaPlan || '').slice(0, 200),
  currency:
    b.currency === undefined
      ? base.currency || 'USD'
      : CURRENCIES.includes(b.currency)
        ? b.currency
        : base.currency || 'USD',
  sortOrder: b.sortOrder === undefined ? base.sortOrder || 0 : num(b.sortOrder, 0),
});

/** 组合变动后，把受影响月份的缓存刷新一遍（只刷有月报的月份） */
function refreshCachedInvestments(months) {
  const cfg = getConfig();
  for (const m of months) {
    if (!isMonth(m)) continue;
    if (!getSnapshotRow(m)) continue;
    const fx = fxFor(m, cfg);
    const auto = investmentForMonth(m, fx);
    if (auto.detail.length) cacheInvestment(m, fx);
    else db.prepare('DELETE FROM investments WHERE month = ?').run(m);
  }
}

api.get('/portfolios', wrap(async (_req, res) => {
  const cfg = getConfig();
  const fx = fxFor(todayMonth(), cfg);
  res.json({ ...portfolioOverview(fx), fx: { usd: round2(fx.usd), hkd: round2(fx.hkd), source: cfg.fx_source } });
}));

api.post('/portfolios', wrap(async (req, res) => {
  const p = pfPayload(req.body || {});
  if (!p.name) throw fail('组合名称不能为空');
  if (p.name.length > 60) throw fail('组合名称过长（最多 60 字）');
  const info = db
    .prepare(
      'INSERT INTO portfolios (name, allocation, dca_plan, currency, sort_order, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    )
    .run(p.name, p.allocation, p.dcaPlan, p.currency, p.sortOrder, new Date().toISOString());
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

api.patch('/portfolios/:id', wrap(async (req, res) => {
  const pf = getPortfolio(req.params.id);
  if (!pf) throw fail('组合不存在', 404);
  const b = req.body || {};
  const p = pfPayload(b, {
    name: pf.name,
    allocation: pf.allocation,
    dcaPlan: pf.dca_plan,
    currency: pf.currency,
    sortOrder: pf.sort_order,
  });
  if (!p.name) throw fail('组合名称不能为空');
  db.prepare(
    'UPDATE portfolios SET name = ?, allocation = ?, dca_plan = ?, currency = ?, sort_order = ?, archived = ? WHERE id = ?',
  ).run(
    p.name.slice(0, 60),
    p.allocation,
    p.dcaPlan,
    p.currency,
    p.sortOrder,
    b.archived === undefined ? pf.archived : b.archived ? 1 : 0,
    pf.id,
  );
  // 改了币种会影响折算，刷新缓存
  refreshCachedInvestments(portfolioMonths());
  res.json({ ok: true });
}));

api.delete('/portfolios/:id', wrap(async (req, res) => {
  const pf = getPortfolio(req.params.id);
  if (!pf) throw fail('组合不存在', 404);
  const months = portfolioMonths();
  if (req.query.purge === '1') {
    db.transaction(() => {
      deletePortfolioRecords(pf.id);
      db.prepare('DELETE FROM portfolios WHERE id = ?').run(pf.id);
    })();
    refreshCachedInvestments(months);
    return res.json({ ok: true, purged: true });
  }
  db.prepare('UPDATE portfolios SET archived = 1 WHERE id = ?').run(pf.id);
  refreshCachedInvestments(months);
  res.json({ ok: true, archived: true });
}));

api.post('/portfolios/:id/records', wrap(async (req, res) => {
  const pf = getPortfolio(req.params.id);
  if (!pf) throw fail('组合不存在', 404);
  const b = req.body || {};
  const month = b.month === undefined ? todayMonth() : String(b.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  const invested = Number(b.invested);
  const value = Number(b.value);
  if (!Number.isFinite(invested) || invested < 0) throw fail('投入本金须为不小于 0 的数字');
  if (!Number.isFinite(value) || value < 0) throw fail('当前市值须为不小于 0 的数字');
  upsertRecord({ portfolioId: pf.id, month, invested, value, note: b.note });
  refreshCachedInvestments([month]);
  res.status(201).json({ ok: true, month });
}));

api.delete('/records/:id', wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM portfolio_records WHERE id = ?').get(num(req.params.id));
  if (!r) throw fail('记录不存在', 404);
  db.prepare('DELETE FROM portfolio_records WHERE id = ?').run(r.id);
  refreshCachedInvestments([r.month]);
  res.json({ ok: true });
}));

/** 一次性批量录入某月所有组合的市值（持仓页的快捷录入） */
api.post('/records/bulk', wrap(async (req, res) => {
  const b = req.body || {};
  const month = b.month === undefined ? todayMonth() : String(b.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  const rows = Array.isArray(b.records) ? b.records : [];
  if (!rows.length) throw fail('没有要保存的记录');
  let saved = 0;
  db.transaction(() => {
    for (const r of rows) {
      const pf = getPortfolio(r.portfolioId);
      if (!pf) continue;
      const invested = num(r.invested, 0);
      const value = num(r.value, 0);
      if (invested < 0 || value < 0) continue;
      upsertRecord({ portfolioId: pf.id, month, invested: invested, value: value, note: r.note });
      saved += 1;
    }
  })();
  refreshCachedInvestments([month]);
  res.json({ ok: true, month, saved });
}));

/* ---------------- 月度快照 ---------------- */

function buildSnapshot(month) {
  const cfg = getConfig();
  const fx = fxFor(month, cfg);
  const prev = prevMonthOf(month);
  const snap = getSnapshotRow(month);

  const accounts = accountList();
  const entryRows = db.prepare('SELECT * FROM entries WHERE month = ?').all(month);
  const entryMap = new Map(entryRows.map((r) => [r.account_id, r]));
  const prevRows = prev ? db.prepare('SELECT * FROM entries WHERE month = ?').all(prev) : [];
  const prevMap = new Map(prevRows.map((r) => [r.account_id, r]));

  const cash = accounts.map((a) => {
    const saved = entryMap.get(a.id);
    const fromPrev = !saved && prevMap.get(a.id);
    const balance = saved ? num(saved.balance) : fromPrev ? num(fromPrev.balance) : 0;
    return {
      accountId: a.id,
      name: a.name,
      kind: a.kind,
      currency: a.currency,
      note: a.note,
      balance: round2(balance),
      balanceCny: round2(balance * fx.toCny(a.currency)),
      saved: Boolean(saved),
      carried: Boolean(fromPrev),
      prevBalance: prevMap.get(a.id) ? round2(prevMap.get(a.id).balance) : null,
    };
  });

  const liabilities = db
    .prepare('SELECT * FROM liabilities WHERE month = ? ORDER BY id')
    .all(month)
    .map((r) => ({ ...r, amountCny: round2(num(r.amount) * fx.toCny(r.currency)) }));

  const inv = investmentOf(month, fx);
  const totals = monthTotals(month, cfg);
  const prevTotals = prev ? monthTotals(prev, cfg) : null;

  return {
    month,
    exists:
      Boolean(snap) || cash.some((c) => c.saved) || liabilities.length > 0 || Boolean(inv.detail.length || inv.manual),
    meta: {
      confirmed: Boolean(snap?.confirmed),
      note: snap?.note || '',
      updatedAt: snap?.updated_at || null,
      hasSnapshotRow: Boolean(snap),
    },
    fx: { usd: round2(fx.usd), hkd: round2(fx.hkd), source: cfg.fx_source },
    cash,
    liabilities,
    investment: {
      valueCny: round2(inv.valueCny || 0),
      investedCny: round2(inv.investedCny || 0),
      source: inv.detail.length ? 'portfolio' : inv.manual ? 'manual' : null,
      manual: Boolean(inv.manual),
      partial: Boolean(inv.partial),
      warnings: inv.warnings || [],
      detail: inv.detail || [],
      syncedAt: inv.syncedAt || null,
      note: inv.note || '',
    },
    totals,
    prev: prev ? { month: prev, totals: prevTotals } : null,
    change: withChange(totals, prevTotals),
  };
}

api.get('/months', wrap(async (_req, res) => {
  const cfg = getConfig();
  const out = allMonths().map((m) => {
    const snap = getSnapshotRow(m);
    return { month: m, confirmed: Boolean(snap?.confirmed), ...monthTotals(m, cfg) };
  });
  res.json({ months: out, currentMonth: todayMonth() });
}));

api.get('/snapshot/:month', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  res.json(buildSnapshot(month));
}));

api.put('/snapshot/:month', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  const b = req.body || {};
  const cfg = getConfig();
  const now = new Date().toISOString();

  // 保存时把当期汇率一起记下，历史月份的人民币口径就不会随汇率变动而漂移
  const rates = await fetchFx();
  const fxUsd = round2(Number(rates.CNY) || cfg.fx_usd_cny);
  const fxHkd = round2(fxUsd / (Number(rates.HKD) || fxUsd / cfg.fx_hkd_cny));

  const cash = Array.isArray(b.cash) ? b.cash : [];
  const liabs = Array.isArray(b.liabilities) ? b.liabilities : [];

  db.transaction(() => {
    const exists = getSnapshotRow(month);
    if (exists) {
      db.prepare(
        'UPDATE snapshots SET note = ?, confirmed = ?, fx_usd = ?, fx_hkd = ?, updated_at = ? WHERE month = ?',
      ).run(
        String(b.note ?? exists.note ?? '').slice(0, 300),
        b.confirmed === undefined ? exists.confirmed : b.confirmed ? 1 : 0,
        fxUsd,
        fxHkd,
        now,
        month,
      );
    } else {
      db.prepare(
        'INSERT INTO snapshots (month, note, confirmed, fx_usd, fx_hkd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(month, String(b.note || '').slice(0, 300), b.confirmed ? 1 : 0, fxUsd, fxHkd, now, now);
    }

    const upsert = db.prepare(
      `INSERT INTO entries (month, account_id, balance) VALUES (?, ?, ?)
       ON CONFLICT(month, account_id) DO UPDATE SET balance = excluded.balance`,
    );
    const keep = new Set();
    for (const c of cash) {
      const id = num(c.accountId);
      if (!id || !db.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').get(id)) continue;
      upsert.run(month, id, num(c.balance));
      keep.add(id);
    }
    for (const row of db.prepare('SELECT account_id FROM entries WHERE month = ?').all(month)) {
      if (!keep.has(row.account_id)) {
        db.prepare('DELETE FROM entries WHERE month = ? AND account_id = ?').run(month, row.account_id);
      }
    }

    db.prepare('DELETE FROM liabilities WHERE month = ?').run(month);
    const insLiab = db.prepare(
      'INSERT INTO liabilities (month, name, kind, amount, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of liabs) {
      const name = String(l.name || '').trim();
      if (!name) continue;
      insLiab.run(
        month,
        name.slice(0, 40),
        LIAB_KINDS.includes(l.kind) ? l.kind : 'credit',
        Math.max(0, num(l.amount)),
        CURRENCIES.includes(l.currency) ? l.currency : 'CNY',
        String(l.note || '').slice(0, 100),
        now,
      );
    }

    // 理财：有持仓记录就自动算并缓存，没有才接受手动填的值
    const fx = { usd: fxUsd, hkd: fxHkd, toCny: (cur) => (cur === 'USD' ? fxUsd : cur === 'HKD' ? fxHkd : 1) };
    const auto = investmentForMonth(month, fx);
    if (auto.detail.length) {
      cacheInvestment(month, fx, { note: b.investment?.note });
    } else if (b.investment && (b.investment.valueCny !== undefined || b.investment.investedCny !== undefined)) {
      db.prepare(
        `INSERT INTO investments (month, value_cny, invested_cny, source, detail, synced_at, note)
         VALUES (?, ?, ?, 'manual', '[]', ?, ?)
         ON CONFLICT(month) DO UPDATE SET value_cny = excluded.value_cny, invested_cny = excluded.invested_cny,
           source = 'manual', detail = '[]', synced_at = excluded.synced_at, note = excluded.note`,
      ).run(
        month,
        Math.max(0, num(b.investment.valueCny)),
        Math.max(0, num(b.investment.investedCny)),
        now,
        String(b.investment.note || '').slice(0, 200),
      );
    }
  })();

  res.json(buildSnapshot(month));
}));

api.delete('/snapshot/:month', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  db.transaction(() => {
    db.prepare('DELETE FROM entries WHERE month = ?').run(month);
    db.prepare('DELETE FROM liabilities WHERE month = ?').run(month);
    db.prepare('DELETE FROM investments WHERE month = ?').run(month);
    db.prepare('DELETE FROM snapshots WHERE month = ?').run(month);
  })();
  res.json({ ok: true });
}));

/** 只保存「已确认」标记 */
api.post('/snapshot/:month/confirm', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  const now = new Date().toISOString();
  const cfg = getConfig();
  const snap = getSnapshotRow(month);
  const confirmed = req.body?.confirmed === undefined ? true : Boolean(req.body.confirmed);
  if (snap) {
    db.prepare('UPDATE snapshots SET confirmed = ?, updated_at = ? WHERE month = ?').run(confirmed ? 1 : 0, now, month);
  } else {
    const rates = await fetchFx();
    db.prepare(
      'INSERT INTO snapshots (month, note, confirmed, fx_usd, fx_hkd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(month, '', confirmed ? 1 : 0, Number(rates.CNY) || cfg.fx_usd_cny, cfg.fx_hkd_cny, now, now);
  }
  res.json(buildSnapshot(month));
}));

/** 用内置持仓重算本月理财（相当于旧版的「同步」，现在纯本地计算） */
api.post('/snapshot/:month/recalc', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!isMonth(month)) throw fail('月份格式须为 YYYY-MM');
  const cfg = getConfig();
  const fx = fxFor(month, cfg);
  const auto = investmentForMonth(month, fx);
  if (!auto.hasPortfolios) throw fail('还没有任何投资组合，请先在「持仓」页添加');
  if (!auto.detail.length) throw fail(`所有组合在 ${month} 及之前都没有月度记录`);
  cacheInvestment(month, fx);
  res.json({ ...auto, month, snapshot: buildSnapshot(month) });
}));

/* ---------------- 趋势 ---------------- */

api.get('/trend', wrap(async (req, res) => {
  const limit = Math.max(1, Math.min(120, num(req.query.limit, 36)));
  const cfg = getConfig();
  const months = allMonths();
  const rows = months.map((m) => monthTotals(m, cfg));
  const withChanges = rows.map((r, i) => ({ ...r, change: withChange(r, i > 0 ? rows[i - 1] : null) }));
  const trimmed = withChanges.slice(-limit);

  const gaps = [];
  for (let i = 1; i < months.length; i += 1) {
    const [py, pm] = months[i - 1].split('-').map(Number);
    const [cy, cm] = months[i].split('-').map(Number);
    const diff = (cy - py) * 12 + (cm - pm);
    if (diff > 1) gaps.push({ from: months[i - 1], to: months[i], missing: diff - 1 });
  }

  res.json({
    trend: trimmed,
    months,
    gaps,
    latest: trimmed.length ? trimmed[trimmed.length - 1] : null,
    currentMonth: todayMonth(),
    fx: { usd: cfg.fx_usd_cny, hkd: cfg.fx_hkd_cny, source: cfg.fx_source },
  });
}));

/* ---------------- 设置 / 汇率 / 备份 ---------------- */

api.get('/config', wrap(async (_req, res) => {
  const cfg = getConfig();
  res.json({
    fx_usd_cny: cfg.fx_usd_cny,
    fx_hkd_cny: cfg.fx_hkd_cny,
    fx_source: cfg.fx_source,
    envOverride: { fx: Boolean(process.env.FX_USD_CNY || process.env.FX_HKD_CNY) },
    version: process.env.APP_VERSION || '',
  });
}));

api.patch('/config', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.fx_source !== undefined) patch.fx_source = b.fx_source === 'manual' ? 'manual' : 'auto';
  if (b.fx_usd_cny !== undefined) {
    const v = Number(b.fx_usd_cny);
    if (!Number.isFinite(v) || v <= 0) throw fail('美元汇率须为正数');
    patch.fx_usd_cny = v.toFixed(4);
  }
  if (b.fx_hkd_cny !== undefined) {
    const v = Number(b.fx_hkd_cny);
    if (!Number.isFinite(v) || v <= 0) throw fail('港币汇率须为正数');
    patch.fx_hkd_cny = v.toFixed(4);
  }
  setSettings(patch);
  res.json({ ok: true });
}));

api.post('/fx/refresh', wrap(async (_req, res) => {
  const rates = await fetchFx(true);
  const cfg = getConfig();
  const out = {
    usd: round2(Number(rates.CNY) || cfg.fx_usd_cny),
    hkd: round2((Number(rates.CNY) || cfg.fx_usd_cny) / (Number(rates.HKD) || 1)),
  };
  if (cfg.fx_source === 'auto') setSettings({ fx_usd_cny: out.usd, fx_hkd_cny: out.hkd });
  res.json({ ok: true, ...out, source: cfg.fx_source });
}));

api.get('/export', wrap(async (_req, res) => {
  res.json({
    app: 'monthly-balance-sheet',
    version: 2,
    exportedAt: new Date().toISOString(),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all(),
    entries: db.prepare('SELECT * FROM entries ORDER BY month, account_id').all(),
    liabilities: db.prepare('SELECT * FROM liabilities ORDER BY month, id').all(),
    portfolios: db.prepare('SELECT * FROM portfolios ORDER BY sort_order, id').all(),
    portfolioRecords: db.prepare('SELECT * FROM portfolio_records ORDER BY portfolio_id, month').all(),
    investments: db.prepare('SELECT * FROM investments ORDER BY month').all(),
    snapshots: db.prepare('SELECT * FROM snapshots ORDER BY month').all(),
  });
}));

api.post('/import', wrap(async (req, res) => {
  const b = req.body || {};
  const data = typeof b.data === 'string' ? JSON.parse(b.data) : b.data || b;
  const hasLedger = Array.isArray(data.accounts) && Array.isArray(data.entries);
  // 旧 portfolio-tracker 的备份只有 portfolios + records（无 accounts/entries），单独兼容
  const portfolioOnly =
    !hasLedger && (Array.isArray(data.portfolios) || Array.isArray(data.records) || Array.isArray(data.month_records));
  if (!hasLedger && !portfolioOnly) {
    throw fail('备份格式不正确：既不是本应用的备份（缺 accounts/entries），也不是 portfolio-tracker 的备份（缺 portfolios/records）');
  }
  const mode = b.mode === 'replace' ? 'replace' : 'merge';
  const now = new Date().toISOString();
  const counts = {
    accounts: 0,
    accountsReused: 0,
    entries: 0,
    liabilities: 0,
    portfolios: 0,
    portfoliosReused: 0,
    portfolioRecords: 0,
    investments: 0,
    snapshots: 0,
  };

  db.transaction(() => {
    if (mode === 'replace') {
      // 纯组合备份只清理组合相关表，别把现金账户和月报一起删了
      if (!portfolioOnly) {
        db.prepare('DELETE FROM entries').run();
        db.prepare('DELETE FROM liabilities').run();
        db.prepare('DELETE FROM investments').run();
        db.prepare('DELETE FROM snapshots').run();
        db.prepare('DELETE FROM accounts').run();
      }
      db.prepare('DELETE FROM portfolio_records').run();
      db.prepare('DELETE FROM portfolios').run();
    }
    const insAcc = db.prepare(
      'INSERT INTO accounts (name, kind, currency, sort_order, archived, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const idMap = new Map();
    const findAcc = db.prepare('SELECT id FROM accounts WHERE name = ? AND currency = ? ORDER BY archived, id LIMIT 1');
    for (const a of data.accounts || []) {
      const name = String(a.name || '').trim();
      if (!name) continue;
      const currency = CURRENCIES.includes(a.currency) ? a.currency : 'CNY';
      // 合并模式下同名同币种视为同一个账户，避免重复导入把现金翻倍
      if (mode !== 'replace') {
        const hit = findAcc.get(name.slice(0, 40), currency);
        if (hit) {
          idMap.set(Number(a.id), Number(hit.id));
          counts.accountsReused += 1;
          continue;
        }
      }
      const info = insAcc.run(
        name.slice(0, 40),
        KINDS.includes(a.kind) ? a.kind : 'bank',
        currency,
        num(a.sort_order ?? a.sortOrder, 0),
        a.archived ? 1 : 0,
        String(a.note || '').slice(0, 100),
        a.created_at || now,
      );
      idMap.set(Number(a.id), Number(info.lastInsertRowid));
      counts.accounts += 1;
    }
    const upsertEntry = db.prepare(
      `INSERT INTO entries (month, account_id, balance) VALUES (?, ?, ?)
       ON CONFLICT(month, account_id) DO UPDATE SET balance = excluded.balance`,
    );
    for (const e of data.entries || []) {
      const aid = idMap.get(Number(e.account_id));
      if (!aid || !isMonth(e.month)) continue;
      upsertEntry.run(e.month, aid, num(e.balance));
      counts.entries += 1;
    }
    const insLiab = db.prepare(
      'INSERT INTO liabilities (month, name, kind, amount, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of data.liabilities || []) {
      if (!isMonth(l.month) || !String(l.name || '').trim()) continue;
      insLiab.run(
        l.month,
        String(l.name).slice(0, 40),
        LIAB_KINDS.includes(l.kind) ? l.kind : 'credit',
        num(l.amount),
        CURRENCIES.includes(l.currency) ? l.currency : 'CNY',
        String(l.note || '').slice(0, 100),
        l.created_at || now,
      );
      counts.liabilities += 1;
    }

    // 投资组合 + 组合记录（兼容旧 portfolio-tracker 备份的字段名）
    const insPf = db.prepare(
      'INSERT INTO portfolios (name, allocation, dca_plan, currency, sort_order, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const pfMap = new Map();
    const findPf = db.prepare('SELECT id, currency FROM portfolios WHERE name = ? ORDER BY archived, id LIMIT 1');
    for (const p of data.portfolios || []) {
      const name = String(p.name || '').trim();
      if (!name) continue;
      // 合并模式下同名组合视为同一个，避免重复导入把净值算成两倍
      if (mode !== 'replace') {
        const hit = findPf.get(name.slice(0, 60));
        if (hit) {
          pfMap.set(Number(p.id), Number(hit.id));
          counts.portfoliosReused += 1;
          continue;
        }
      }
      const info = insPf.run(
        name.slice(0, 60),
        String(p.allocation ?? p.allocation_detail ?? '').slice(0, 200),
        String(p.dca_plan ?? p.dcaPlan ?? '').slice(0, 200),
        CURRENCIES.includes(p.currency) ? p.currency : 'USD',
        num(p.sort_order ?? p.sortOrder, 0),
        p.archived ? 1 : 0,
        p.created_at || now,
      );
      pfMap.set(Number(p.id), Number(info.lastInsertRowid));
      counts.portfolios += 1;
    }
    const recs = data.portfolioRecords || data.portfolio_records || data.records || data.month_records || [];
    for (const r of recs) {
      const pid = pfMap.get(Number(r.portfolio_id ?? r.portfolioId));
      if (!pid || !isMonth(r.month)) continue;
      upsertRecord({ portfolioId: pid, month: r.month, invested: num(r.invested), value: num(r.value), note: r.note });
      counts.portfolioRecords += 1;
    }
    // 更早版本的备份会把记录嵌在组合里，一并兼容
    for (const p of data.portfolios || []) {
      const pid = pfMap.get(Number(p.id));
      if (!pid) continue;
      for (const r of p.records || p.history || []) {
        if (!isMonth(r.month)) continue;
        upsertRecord({
          portfolioId: pid,
          month: r.month,
          invested: num(r.invested),
          value: num(r.value),
          note: r.note,
        });
        counts.portfolioRecords += 1;
      }
    }

    const insInv = db.prepare(
      `INSERT INTO investments (month, value_cny, invested_cny, source, detail, synced_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET value_cny = excluded.value_cny, invested_cny = excluded.invested_cny,
         source = excluded.source, detail = excluded.detail, synced_at = excluded.synced_at, note = excluded.note`,
    );
    for (const v of data.investments || []) {
      if (!isMonth(v.month)) continue;
      insInv.run(
        v.month,
        num(v.value_cny),
        num(v.invested_cny),
        ['manual', 'portfolio'].includes(v.source) ? v.source : 'manual',
        typeof v.detail === 'string' ? v.detail : JSON.stringify(v.detail || []),
        v.synced_at || now,
        v.note || '',
      );
      counts.investments += 1;
    }
    const insSnap = db.prepare(
      `INSERT INTO snapshots (month, note, confirmed, fx_usd, fx_hkd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET note = excluded.note, confirmed = excluded.confirmed, updated_at = excluded.updated_at`,
    );
    for (const s of data.snapshots || []) {
      if (!isMonth(s.month)) continue;
      insSnap.run(
        s.month,
        s.note || '',
        s.confirmed ? 1 : 0,
        num(s.fx_usd, 7.1),
        num(s.fx_hkd, 0.92),
        s.created_at || now,
        s.updated_at || now,
      );
      counts.snapshots += 1;
    }
  })();

  res.json({ ok: true, mode, portfolioOnly, ...counts });
}));

export default api;
