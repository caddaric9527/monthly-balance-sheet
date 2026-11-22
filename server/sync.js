import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getConfig } from './db.js';
import { fetchFx, cnyRate, round2 } from './fx.js';

const UA = 'monthly-balance-sheet/1.0';
const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

/** 从组合的历史里挑出 <= 目标月份的最后一条记录 */
function pickRecord(history, month) {
  const sorted = [...history].filter((r) => isMonth(r.month)).sort((a, b) => a.month.localeCompare(b.month));
  if (!sorted.length) return null;
  const exact = sorted.find((r) => r.month === month);
  if (exact) return { rec: exact, exact: true };
  const earlier = sorted.filter((r) => r.month <= month);
  if (!earlier.length) return null;
  return { rec: earlier[earlier.length - 1], exact: false };
}

/** 把各组合记录汇总成 CNY 口径 */
function summarize(items, rates, month) {
  const detail = [];
  const warnings = [];
  let partial = false;

  for (const it of items) {
    const picked = pickRecord(it.history || [], month);
    if (!picked) {
      warnings.push(`「${it.name}」在 ${month} 及之前没有月度记录`);
      continue;
    }
    const { rec, exact } = picked;
    if (!exact) partial = true;
    const rate = cnyRate(rates, it.currency);
    const value = Number(rec.value) || 0;
    const invested = Number(rec.invested) || 0;
    detail.push({
      name: it.name,
      currency: it.currency || 'CNY',
      month: rec.month,
      exact,
      value: round2(value),
      invested: round2(invested),
      valueCny: round2(value * rate),
      investedCny: round2(invested * rate),
    });
  }

  const valueCny = round2(detail.reduce((s, d) => s + d.valueCny, 0));
  const investedCny = round2(detail.reduce((s, d) => s + d.investedCny, 0));
  return { detail, valueCny, investedCny, partial, warnings };
}

/* ---------------- 模式一：同机只读 SQLite ---------------- */
function syncFromDb(dbPath, month) {
  const abs = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(abs)) {
    throw Object.assign(new Error(`找不到 portfolio-tracker 数据库：${abs}`), { status: 400 });
  }

  const conn = new Database(abs, { readonly: true, fileMustExist: true });
  try {
    const portfolios = conn.prepare('SELECT id, name, currency, sort_order FROM portfolios ORDER BY sort_order, id').all();
    const records = conn.prepare('SELECT portfolio_id, month, invested, value FROM month_records').all();
    let settings = {};
    try {
      settings = Object.fromEntries(conn.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    } catch {
      /* 老版本可能没有 settings 表 */
    }

    const usd = Number(settings.fx_usd_cny) || 7.1;
    const hkd = Number(settings.fx_hkd_cny) || 0.92;
    const rates = { USD: 1, CNY: usd, HKD: usd / hkd };

    const items = portfolios.map((p) => ({
      name: p.name,
      currency: p.currency,
      history: records.filter((r) => r.portfolio_id === p.id),
    }));

    return { mode: 'db', source: abs, ...summarize(items, rates, month) };
  } finally {
    conn.close();
  }
}

/* ---------------- 模式二：调用 portfolio-tracker HTTP 接口 ---------------- */
async function syncFromApi(baseUrl, password, month) {
  if (!baseUrl) throw Object.assign(new Error('请先在设置里填写 portfolio-tracker 地址'), { status: 400 });
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { 'User-Agent': UA, Accept: 'application/json' };

  if (password) {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!login.ok) {
      const msg = await login.json().catch(() => ({}));
      throw Object.assign(new Error(`登录 portfolio-tracker 失败：${msg.error || login.status}`), { status: 400 });
    }
    const cookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    if (cookies.length) headers.Cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  }

  const res = await fetch(`${base}/api/overview`, { headers });
  if (!res.ok) {
    throw Object.assign(new Error(`读取 portfolio-tracker 概览失败：HTTP ${res.status}`), { status: 400 });
  }
  const data = await res.json();
  // 上游给的是「1 单位外币 = 多少 CNY」，这里换成以 USD 为基准的汇率表
  const toCny = data.fx?.toCny || { USD: 7.1, HKD: 0.92, CNY: 1 };
  const cnyPerUsd = Number(toCny.USD) || 7.1;
  const cnyPerHkd = Number(toCny.HKD) || 0.92;
  const rates = { USD: 1, CNY: cnyPerUsd, HKD: cnyPerUsd / cnyPerHkd };

  const items = (data.portfolios || []).map((p) => ({
    name: p.name,
    currency: p.currency,
    history: p.history || [],
  }));

  return { mode: 'api', source: base, ...summarize(items, rates, month) };
}

/**
 * 同步某个月的理财市值（不写库，只返回结果）
 */
export async function syncPortfolio(month, override = {}) {
  const cfg = { ...getConfig(), ...override };
  const m = isMonth(month) ? month : new Date().toLocaleDateString('sv-SE').slice(0, 7);

  if (cfg.portfolio_mode === 'db') {
    if (!cfg.portfolio_db_path) {
      throw Object.assign(new Error('请先在设置里填写 portfolio-tracker 的数据库路径'), { status: 400 });
    }
    return { ...syncFromDb(cfg.portfolio_db_path, m), month: m };
  }

  if (cfg.portfolio_mode === 'api') {
    const out = await syncFromApi(cfg.portfolio_base_url, cfg.portfolio_password, m);
    return { ...out, month: m };
  }

  throw Object.assign(new Error('当前是「手动填写」模式，请先在设置里选择理财数据源'), { status: 400 });
}

/** 连通性测试：不依赖具体月份，返回能否读到组合 */
export async function testConnection(override = {}) {
  const cfg = { ...getConfig(), ...override };
  const now = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  if (cfg.portfolio_mode === 'manual') {
    return { ok: true, mode: 'manual', message: '手动填写模式，无需连接' };
  }
  try {
    const out = await syncPortfolio(now, override);
    const n = out.detail.length;
    return {
      ok: true,
      mode: out.mode,
      source: out.source,
      message: n ? `连接成功，读取到 ${n} 个组合（基准月 ${now}）` : '连接成功，但还没有任何组合记录',
      sample: out.detail.slice(0, 5),
    };
  } catch (e) {
    return { ok: false, mode: cfg.portfolio_mode, message: e.message };
  }
}

export { isMonth };
export default { syncPortfolio, testConnection, isMonth, fetchFx };
