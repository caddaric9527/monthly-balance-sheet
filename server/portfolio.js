import { db } from './db.js';
import { round2 } from './fx.js';

/**
 * 内置的投资组合模块（原 portfolio-tracker 的持仓管理能力，现已合并进来）。
 * 只读写本项目的 SQLite，不再依赖外部数据库或 HTTP 接口。
 */

export const CURRENCIES = ['CNY', 'USD', 'HKD'];
export const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
export const todayMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

/* ---------------- 读取 ---------------- */

export function listPortfolios({ includeArchived = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM portfolios ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort_order, id`)
    .all();
  const recs = db.prepare('SELECT * FROM portfolio_records ORDER BY month').all();
  const byPf = new Map();
  for (const r of recs) {
    if (!byPf.has(r.portfolio_id)) byPf.set(r.portfolio_id, []);
    byPf.get(r.portfolio_id).push(r);
  }
  return rows.map((p) => {
    const history = enrich(byPf.get(p.id) || []);
    const latest = history.length ? history[history.length - 1] : null;
    return {
      id: p.id,
      name: p.name,
      allocation: p.allocation || '',
      dcaPlan: p.dca_plan || '',
      currency: p.currency,
      sortOrder: p.sort_order,
      archived: Boolean(p.archived),
      createdAt: p.created_at,
      latest,
      recordCount: history.length,
      history,
    };
  });
}

/** 给一条记录补上盈亏、收益率、当月投入与当月盈亏 */
function enrich(records) {
  let prev = null;
  return records.map((r) => {
    const gain = r.value - r.invested;
    const returnPct = r.invested > 0 ? round2((gain / r.invested) * 100) : null;
    const monthInvested = prev ? r.invested - prev.invested : r.invested;
    const monthPnl = prev ? r.value - prev.value - monthInvested : gain;
    prev = r;
    const out = {
      id: r.id,
      month: r.month,
      invested: round2(r.invested),
      value: round2(r.value),
      note: r.note || '',
      gain: round2(gain),
      returnPct,
      monthInvested: round2(monthInvested),
      monthPnl: round2(monthPnl),
    };
    return out;
  });
}

/** 从组合历史里挑出 <= 目标月份的最后一条记录 */
function pickRecord(history, month) {
  if (!history.length) return null;
  const exact = history.find((r) => r.month === month);
  if (exact) return { rec: exact, exact: true };
  const earlier = history.filter((r) => r.month <= month);
  if (!earlier.length) return null;
  return { rec: earlier[earlier.length - 1], exact: false };
}

/**
 * 某个月的理财市值：把各组合在该月（或之前最近月）的记录折算成人民币。
 * @param {string} month  YYYY-MM
 * @param {{toCny:(cur:string)=>number}} fx 该月锁定的汇率
 */
export function investmentForMonth(month, fx) {
  const portfolios = listPortfolios();
  const detail = [];
  const warnings = [];
  let partial = false;

  for (const pf of portfolios) {
    const picked = pickRecord(pf.history, month);
    if (!picked) {
      warnings.push(`「${pf.name}」在 ${month} 及之前还没有月度记录`);
      continue;
    }
    const { rec, exact } = picked;
    if (!exact) partial = true;
    const rate = fx.toCny(pf.currency);
    detail.push({
      portfolioId: pf.id,
      name: pf.name,
      currency: pf.currency,
      month: rec.month,
      exact,
      value: round2(rec.value),
      invested: round2(rec.invested),
      valueCny: round2(rec.value * rate),
      investedCny: round2(rec.invested * rate),
    });
  }

  const valueCny = round2(detail.reduce((s, d) => s + d.valueCny, 0));
  const investedCny = round2(detail.reduce((s, d) => s + d.investedCny, 0));
  return {
    source: 'portfolio',
    hasPortfolios: portfolios.length > 0,
    valueCny,
    investedCny,
    detail,
    partial,
    warnings,
  };
}

/** 持仓总览：组合列表 + 月度趋势 + 汇总（持仓页用） */
export function portfolioOverview(fx) {
  const items = listPortfolios().map((pf) => {
    const rate = fx.toCny(pf.currency);
    return {
      ...pf,
      rate,
      latest: pf.latest
        ? { ...pf.latest, valueCny: round2(pf.latest.value * rate), investedCny: round2(pf.latest.invested * rate) }
        : null,
      history: pf.history.map((r) => ({
        ...r,
        valueCny: round2(r.value * rate),
        investedCny: round2(r.invested * rate),
      })),
    };
  });
  const byMonth = new Map();
  for (const pf of items) {
    for (const r of pf.history) {
      const m = byMonth.get(r.month) || { month: r.month, invested: 0, value: 0 };
      m.invested += r.investedCny;
      m.value += r.valueCny;
      byMonth.set(r.month, m);
    }
  }
  const trend = [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      invested: round2(m.invested),
      value: round2(m.value),
      gain: round2(m.value - m.invested),
      returnPct: m.invested > 0 ? round2(((m.value - m.invested) / m.invested) * 100) : null,
    }));

  const latest = trend.length ? trend[trend.length - 1] : null;
  const prev = trend.length > 1 ? trend[trend.length - 2] : null;
  const summary = {
    portfolioCount: items.length,
    recorded: items.filter((i) => i.latest).length,
    months: trend.length,
    invested: latest ? latest.invested : 0,
    value: latest ? latest.value : 0,
    gain: latest ? latest.gain : 0,
    returnPct: latest ? latest.returnPct : null,
    monthInvested: latest && prev ? round2(latest.invested - prev.invested) : latest ? latest.invested : 0,
    monthPnl:
      latest && prev
        ? round2(latest.value - prev.value - (latest.invested - prev.invested))
        : latest
          ? latest.gain
          : 0,
    latestMonth: latest ? latest.month : null,
  };

  return { portfolios: items, trend, summary };
}

/* ---------------- 写入（供 routes 调用） ---------------- */

export function getPortfolio(id) {
  return db.prepare('SELECT * FROM portfolios WHERE id = ?').get(Number(id));
}

export function deletePortfolioRecords(portfolioId) {
  db.prepare('DELETE FROM portfolio_records WHERE portfolio_id = ?').run(Number(portfolioId));
}

/** 某月所有组合都有记录？没有则说明还有组合缺记录 */
export function missingPortfolios(month) {
  const rows = db.prepare('SELECT id, name FROM portfolios WHERE archived = 0 ORDER BY sort_order, id').all();
  return rows
    .filter((p) => !db.prepare('SELECT 1 AS x FROM portfolio_records WHERE portfolio_id = ? AND month = ?').get(p.id, month))
    .map((p) => p.name);
}

/** 把某月的持仓汇总写进 investments 缓存表 */
export function cacheInvestment(month, fx, extra = {}) {
  const inv = investmentForMonth(month, fx);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO investments (month, value_cny, invested_cny, source, detail, synced_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET value_cny = excluded.value_cny, invested_cny = excluded.invested_cny,
       source = excluded.source, detail = excluded.detail, synced_at = excluded.synced_at, note = excluded.note`,
  ).run(
    month,
    Math.max(0, inv.valueCny),
    Math.max(0, inv.investedCny),
    inv.hasPortfolios ? 'portfolio' : 'manual',
    JSON.stringify(inv.detail.slice(0, 50)),
    now,
    String(extra.note || '').slice(0, 200),
  );
  return { ...inv, syncedAt: now };
}

/** 保存组合记录（同月覆盖） */
export function upsertRecord({ portfolioId, month, invested, value, note }) {
  db.prepare(
    `INSERT INTO portfolio_records (portfolio_id, month, invested, value, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(portfolio_id, month) DO UPDATE SET
       invested = excluded.invested, value = excluded.value, note = excluded.note`,
  ).run(portfolioId, month, invested, value, String(note || '').slice(0, 200), new Date().toISOString());
}

/** 已用过持仓记录的月份（升序） */
export function portfolioMonths() {
  return db
    .prepare('SELECT DISTINCT month FROM portfolio_records ORDER BY month')
    .all()
    .map((r) => r.month)
    .filter(isMonth);
}

export default {
  listPortfolios,
  investmentForMonth,
  portfolioOverview,
  cacheInvestment,
  upsertRecord,
  portfolioMonths,
  missingPortfolios,
  isMonth,
  todayMonth,
};
