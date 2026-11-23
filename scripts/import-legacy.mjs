/**
 * 把旧 portfolio-tracker 的数据一次性搬进本项目（内置持仓表）。
 *
 * 用法：
 *   node scripts/import-legacy.mjs ../portfolio-tracker/data/portfolio.db
 *   node scripts/import-legacy.mjs ~/Downloads/portfolio-backup-2026-10-31.json
 *   node scripts/import-legacy.mjs <文件> --force
 *
 * 说明：
 *   - 支持两种来源：旧应用的 SQLite 库（portfolio.db），或它「设置 → 导出」得到的 JSON 备份
 *   - 只读旧文件，不改动它；写入本项目的 data/balance.db
 *   - 默认在已有组合时拒绝执行，加 --force 才会继续（同名组合会合并，不会重复计数）
 *   - 导入后到「持仓」页确认，历史月报的理财金额会自动重算
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../server/db.js';
import { upsertRecord } from '../server/portfolio.js';

const src = process.argv[2];
const force = process.argv.includes('--force');

if (!src) {
  console.error('用法：node scripts/import-legacy.mjs <portfolio.db 或 备份.json> [--force]');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), src);
if (!fs.existsSync(abs)) {
  console.error(`找不到文件：${abs}`);
  process.exit(1);
}

const existing = db.prepare('SELECT COUNT(*) AS c FROM portfolios').get().c;
if (existing > 0 && !force) {
  console.error(`当前已有 ${existing} 个组合，为避免重复导入已停止。确认要合并请加 --force。`);
  process.exit(1);
}

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const CURRENCIES = ['CNY', 'USD', 'HKD'];

/** 统一成 { portfolios, records } 的中间结构 */
function readSource(file) {
  if (/\.json$/i.test(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const portfolios = Array.isArray(data.portfolios) ? data.portfolios : [];
    let records = data.records || data.portfolioRecords || data.portfolio_records || data.month_records || [];
    // 更早版本把记录嵌在组合里
    for (const p of portfolios) {
      for (const r of p.records || p.history || []) records = records.concat([{ ...r, portfolio_id: p.id }]);
    }
    return { portfolios, records, kind: 'json' };
  }
  const legacy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      portfolios: legacy.prepare('SELECT * FROM portfolios ORDER BY sort_order, id').all(),
      records: legacy.prepare('SELECT * FROM month_records ORDER BY portfolio_id, month').all(),
      kind: 'sqlite',
    };
  } finally {
    legacy.close();
  }
}

const { portfolios, records, kind } = readSource(abs);
if (!portfolios.length) {
  console.error(`这个${kind === 'json' ? ' JSON 备份' : '旧库'}里没有组合数据，无需导入。`);
  process.exit(0);
}

const now = new Date().toISOString();
const insPf = db.prepare(
  'INSERT INTO portfolios (name, allocation, dca_plan, currency, sort_order, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
);
const findPf = db.prepare('SELECT id FROM portfolios WHERE name = ? ORDER BY archived, id LIMIT 1');
const idMap = new Map();
let recCount = 0;
let reused = 0;

db.transaction(() => {
  for (const p of portfolios) {
    const name = String(p.name || '未命名组合').slice(0, 60);
    const hit = findPf.get(name);
    if (hit) {
      idMap.set(Number(p.id), Number(hit.id));
      reused += 1;
      continue;
    }
    const info = insPf.run(
      name,
      String(p.allocation ?? p.allocation_detail ?? '').slice(0, 200),
      String(p.dca_plan ?? p.dcaPlan ?? '').slice(0, 200),
      CURRENCIES.includes(p.currency) ? p.currency : 'USD',
      Number(p.sort_order ?? p.sortOrder) || 0,
      p.created_at || now,
    );
    idMap.set(Number(p.id), Number(info.lastInsertRowid));
  }
  for (const r of records) {
    const pid = idMap.get(Number(r.portfolio_id ?? r.portfolioId));
    if (!pid || !isMonth(r.month)) continue;
    upsertRecord({
      portfolioId: pid,
      month: r.month,
      invested: Number(r.invested) || 0,
      value: Number(r.value) || 0,
      note: r.note,
    });
    recCount += 1;
  }
})();

console.log(
  `导入完成（来源：${kind}）：新建 ${portfolios.length - reused} 个组合${reused ? `、合并同名 ${reused} 个` : ''}、${recCount} 条月度记录`,
);
console.log('打开「持仓」页即可看到；已有月报的理财金额会在下次打开或保存时按内置持仓重算。');
