import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'balance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'bank',
  currency    TEXT NOT NULL DEFAULT 'CNY',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  month       TEXT NOT NULL,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  balance     REAL NOT NULL DEFAULT 0,
  UNIQUE(month, account_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_month ON entries(month);

CREATE TABLE IF NOT EXISTS liabilities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  month       TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'credit',
  amount      REAL NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'CNY',
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liab_month ON liabilities(month);

/* 理财：投资组合（内置原 portfolio-tracker 的持仓管理能力） */
CREATE TABLE IF NOT EXISTS portfolios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  allocation  TEXT DEFAULT '',
  dca_plan    TEXT DEFAULT '',
  currency    TEXT NOT NULL DEFAULT 'USD',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,
  invested      REAL NOT NULL DEFAULT 0,
  value         REAL NOT NULL DEFAULT 0,
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE(portfolio_id, month)
);
CREATE INDEX IF NOT EXISTS idx_prec_portfolio ON portfolio_records(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_prec_month ON portfolio_records(month);

/* 理财：某月的汇总缓存（source = portfolio 由持仓算出 / manual 手动覆盖） */
CREATE TABLE IF NOT EXISTS investments (
  month         TEXT PRIMARY KEY,
  value_cny     REAL NOT NULL DEFAULT 0,
  invested_cny  REAL NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual',
  detail        TEXT NOT NULL DEFAULT '[]',
  synced_at     TEXT,
  note          TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS snapshots (
  month       TEXT PRIMARY KEY,
  note        TEXT DEFAULT '',
  confirmed   INTEGER NOT NULL DEFAULT 0,
  fx_usd      REAL NOT NULL DEFAULT 7.1,
  fx_hkd      REAL NOT NULL DEFAULT 0.92,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  fx_usd_cny: '7.10',
  fx_hkd_cny: '0.92',
  fx_source: 'auto',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// 旧版本把 portfolio-tracker 当外部服务，这些键已经没有意义，清掉避免残留
db.prepare("DELETE FROM settings WHERE key LIKE 'portfolio_%'").run();

export const getSettings = () => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};

export const setSettings = (patch) => {
  const upd = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k in DEFAULT_SETTINGS) upd.run(k, String(v ?? ''));
    }
  });
  tx(patch);
  return getSettings();
};

/**
 * 生效配置：环境变量优先于数据库设置（容器部署时改 .env 即可，不用动界面）
 */
export function getConfig() {
  const s = getSettings();
  const env = process.env;
  const pick = (envKey, dbVal) => (env[envKey] !== undefined && env[envKey] !== '' ? env[envKey] : dbVal);
  return {
    fx_usd_cny: Number(pick('FX_USD_CNY', s.fx_usd_cny)) || 7.1,
    fx_hkd_cny: Number(pick('FX_HKD_CNY', s.fx_hkd_cny)) || 0.92,
    fx_source: s.fx_source === 'manual' ? 'manual' : 'auto',
  };
}

export { DATA_DIR, DEFAULT_SETTINGS };
