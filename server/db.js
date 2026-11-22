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
  portfolio_mode: 'manual',
  portfolio_base_url: '',
  portfolio_password: '',
  portfolio_db_path: '',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

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
  const mode = String(pick('PORTFOLIO_MODE', s.portfolio_mode) || 'manual').toLowerCase();
  return {
    fx_usd_cny: Number(s.fx_usd_cny) || 7.1,
    fx_hkd_cny: Number(s.fx_hkd_cny) || 0.92,
    fx_source: s.fx_source === 'manual' ? 'manual' : 'auto',
    portfolio_mode: ['manual', 'api', 'db'].includes(mode) ? mode : 'manual',
    portfolio_base_url: String(pick('PORTFOLIO_BASE_URL', s.portfolio_base_url) || '').replace(/\/+$/, ''),
    portfolio_password: String(pick('PORTFOLIO_PASSWORD', s.portfolio_password) || ''),
    portfolio_db_path: String(pick('PORTFOLIO_DB', s.portfolio_db_path) || ''),
  };
}

export { DATA_DIR, DEFAULT_SETTINGS };
