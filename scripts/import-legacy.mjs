/**
 * 把旧 portfolio-tracker 的数据库一次性搬进本项目（内置持仓表）。
 *
 * 用法：
 *   node scripts/import-legacy.mjs ../portfolio-tracker/data/portfolio.db
 *   node scripts/import-legacy.mjs ../portfolio-tracker/data/portfolio.db --force
 *
 * 说明：
 *   - 只读旧库，不改动它；写入本项目的 data/balance.db
 *   - 默认在已有组合时拒绝执行，加 --force 才会继续追加
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
  console.error('用法：node scripts/import-legacy.mjs <旧 portfolio.db 路径> [--force]');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), src);
if (!fs.existsSync(abs)) {
  console.error(`找不到文件：${abs}`);
  process.exit(1);
}

const existing = db.prepare('SELECT COUNT(*) AS c FROM portfolios').get().c;
if (existing > 0 && !force) {
  console.error(`当前已有 ${existing} 个组合，为避免重复导入已停止。确认要追加请加 --force。`);
  process.exit(1);
}

const legacy = new Database(abs, { readonly: true, fileMustExist: true });
try {
  const portfolios = legacy.prepare('SELECT * FROM portfolios ORDER BY sort_order, id').all();
  const records = legacy.prepare('SELECT * FROM month_records ORDER BY portfolio_id, month').all();
  if (!portfolios.length) {
    console.error('旧库里没有组合数据，无需导入。');
    process.exit(0);
  }

  const now = new Date().toISOString();
  const insPf = db.prepare(
    'INSERT INTO portfolios (name, allocation, dca_plan, currency, sort_order, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  );
  const idMap = new Map();
  let recCount = 0;

  db.transaction(() => {
    for (const p of portfolios) {
      const info = insPf.run(
        String(p.name || '未命名组合').slice(0, 60),
        String(p.allocation || '').slice(0, 200),
        String(p.dca_plan || '').slice(0, 200),
        ['CNY', 'USD', 'HKD'].includes(p.currency) ? p.currency : 'USD',
        Number(p.sort_order) || 0,
        p.created_at || now,
      );
      idMap.set(Number(p.id), Number(info.lastInsertRowid));
    }
    for (const r of records) {
      const pid = idMap.get(Number(r.portfolio_id));
      if (!pid || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(r.month || ''))) continue;
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

  console.log(`导入完成：${portfolios.length} 个组合、${recCount} 条月度记录`);
  console.log('打开「持仓」页即可看到；已有月报的理财金额会在下次打开或保存时按内置持仓重算。');
} finally {
  legacy.close();
}
