import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import bcrypt from "bcryptjs";

let _db: Database.Database | null = null;

function resolveDbPath() {
  const p = process.env.DB_PATH || "./data/app.db";
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed(db);
  _db = db;
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      internal_url TEXT,
      credentials TEXT,
      notes TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);
    CREATE INDEX IF NOT EXISTS idx_services_sort ON services(sort_order);

    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      exporter_url TEXT NOT NULL,
      exporter_type TEXT NOT NULL DEFAULT 'auto',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_private INTEGER NOT NULL DEFAULT 0,
      alerts_enabled INTEGER NOT NULL DEFAULT 1,
      cpu_threshold INTEGER NOT NULL DEFAULT 90,
      mem_threshold INTEGER NOT NULL DEFAULT 90,
      disk_threshold INTEGER NOT NULL DEFAULT 90,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hosts_sort ON hosts(sort_order);

    CREATE TABLE IF NOT EXISTS host_samples (
      host_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      cpu REAL,
      mem REAL,
      load1 REAL,
      disk REAL,
      PRIMARY KEY (host_id, at)
    );
    CREATE INDEX IF NOT EXISTS idx_host_samples_at ON host_samples(at);

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id INTEGER,
      target_name TEXT,
      text TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_events_at ON alert_events(at DESC);

    CREATE TABLE IF NOT EXISTS host_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      last_used_at INTEGER,
      expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

    CREATE TABLE IF NOT EXISTS user_host_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES host_groups(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      remote_host_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (host_id IS NOT NULL AND group_id IS NULL AND agent_id IS NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NOT NULL AND agent_id IS NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NULL AND agent_id IS NOT NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NULL AND agent_id IS NOT NULL AND remote_host_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_user_host_access_user ON user_host_access(user_id);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_item_visibility (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK (item_type IN ('host', 'service')),
      remote_id INTEGER NOT NULL,
      public_visible INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, item_type, remote_id)
    );
  `);
  ensureColumn(db, "services", "check_type", "TEXT NOT NULL DEFAULT 'http'");
  ensureColumn(db, "services", "check_target", "TEXT");
  ensureColumn(db, "services", "alerts_enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "role", "TEXT NOT NULL DEFAULT 'admin'");
  ensureColumn(db, "users", "created_at", "TEXT NOT NULL DEFAULT (datetime('now'))");
  ensureColumn(db, "hosts", "auth_header", "TEXT");
  ensureColumn(db, "hosts", "group_id", "INTEGER REFERENCES host_groups(id) ON DELETE SET NULL");
  ensureColumn(db, "agents", "public_visible", "INTEGER NOT NULL DEFAULT 0");
  migrateUserHostAccessForAgent(db);
  encryptLegacyCredentials(db);
}

/** 迁移 user_host_access 表，添加 agent_id / remote_host_id 列并更新 CHECK 约束（幂等）。 */
function migrateUserHostAccessForAgent(db: Database.Database) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='user_host_access'"
  ).get() as { sql: string } | undefined;
  if (!row) return; // 表不存在（会由 CREATE TABLE IF NOT EXISTS 创建）
  // 检查 CHECK 子句是否已包含 remote_host_id（最终态）
  const checkMatch = row.sql.match(/CHECK\s*\(([\s\S]*)\)\s*\)/i);
  if (checkMatch && checkMatch[1].includes("remote_host_id")) return; // 已是最新

  // 检测旧列情况
  const cols = db.prepare("PRAGMA table_info(user_host_access)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  const insertCols = ["id", "user_id", "host_id", "group_id", "created_at"];
  if (colNames.has("agent_id")) insertCols.splice(4, 0, "agent_id");

  db.exec(`
    CREATE TABLE user_host_access_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES host_groups(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      remote_host_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (host_id IS NOT NULL AND group_id IS NULL AND agent_id IS NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NOT NULL AND agent_id IS NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NULL AND agent_id IS NOT NULL AND remote_host_id IS NULL) OR
        (host_id IS NULL AND group_id IS NULL AND agent_id IS NOT NULL AND remote_host_id IS NOT NULL)
      )
    );
    INSERT INTO user_host_access_new (${insertCols.join(", ")})
      SELECT ${insertCols.join(", ")} FROM user_host_access;
    DROP TABLE user_host_access;
    ALTER TABLE user_host_access_new RENAME TO user_host_access;
    CREATE INDEX IF NOT EXISTS idx_user_host_access_user ON user_host_access(user_id);
  `);
}

/** 一次性把旧的明文 credentials 升级为 AES-GCM 密文（幂等）。 */
function encryptLegacyCredentials(db: Database.Database) {
  try {
    // 延迟 require 避免循环依赖
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { encryptField, CREDENTIAL_PREFIX } = require("./crypto") as typeof import("./crypto");
    const rows = db
      .prepare("SELECT id, credentials FROM services WHERE credentials IS NOT NULL AND credentials <> ''")
      .all() as { id: number; credentials: string }[];
    const legacy = rows.filter((r) => !r.credentials.startsWith(CREDENTIAL_PREFIX));
    if (legacy.length === 0) return;
    const upd = db.prepare("UPDATE services SET credentials = ? WHERE id = ?");
    const tx = db.transaction((items: typeof legacy) => {
      for (const r of items) upd.run(encryptField(r.credentials), r.id);
    });
    tx(legacy);
    // eslint-disable-next-line no-console
    console.log(`[db] 已加密升级 ${legacy.length} 条 services.credentials`);
  } catch (e) {
    // AUTH_SECRET 未就绪时这里会抛；不影响启动
    // eslint-disable-next-line no-console
    console.warn(`[db] credentials 自动加密跳过：${(e as Error).message}`);
  }
}

export type Role = "admin" | "viewer";

function ensureColumn(db: Database.Database, table: string, col: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  brand_name: "Server Hub",
  site_title: "服务导航",
  site_subtitle: "Server Hub",
  welcome_public: "未登录，仅展示公开服务；登录后可查看内网地址、凭据与备注。",
  welcome_authed: "欢迎回来，{{username}}。私有服务与敏感字段已展开。",
  alert_webhook_url: "",
  host_alert_silence_minutes: "10",
  health_alert_silence_minutes: "10",
  alert_history_retention_days: "30",
};

export function getSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(db: Database.Database, patch: Record<string, string>) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const tx = db.transaction((p: Record<string, string>) => {
    for (const [k, v] of Object.entries(p)) stmt.run(k, v);
  });
  tx(patch);
}

function seed(db: Database.Database) {
  const userCount = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (userCount === 0) {
    const username = process.env.ADMIN_USERNAME || "admin";
    const password = process.env.ADMIN_PASSWORD || "admin123";
    const hash = bcrypt.hashSync(password, 10);
    // 首次创建的用户强制要求修改密码（默认口令风险提示）
    db.prepare("INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)").run(username, hash);
    // 引导一条示例，方便第一眼看到效果
    const catCount = (db.prepare("SELECT COUNT(*) AS c FROM categories").get() as { c: number }).c;
    if (catCount === 0) {
      const cat = db.prepare("INSERT INTO categories (name, sort_order) VALUES (?, ?)").run("常用", 0);
      const catId = Number(cat.lastInsertRowid);
      db.prepare(
        `INSERT INTO services (category_id, name, url, icon, description, internal_url, credentials, notes, is_private, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        catId,
        "示例服务",
        "https://example.com",
        "Globe",
        "这是一个示例卡片，登录后可以编辑或删除。",
        "http://192.168.1.10:8080",
        "user: admin\npass: example",
        "部署于 /opt/example，systemd unit: example.service",
        0,
        0
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[db] 已创建初始管理员账号：${username}`);
  }
}

export function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
