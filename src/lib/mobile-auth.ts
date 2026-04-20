import crypto from "node:crypto";
import { getDb } from "./db";
import type { ApiToken, Host, UserHostAccess } from "./types";
import type { Role } from "./auth";

/* ───── Token 生成 / 验证 / 吊销 ───── */

const TOKEN_PREFIX = "snav_";
const TOKEN_BYTES = 32;

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** 创建一个新 API token，返回原始明文（仅此一次可见） */
export function createApiToken(
  userId: number,
  name: string = "",
  expiresDays: number | null = 90,
): { raw: string; record: Omit<ApiToken, "token_hash"> } {
  const raw = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = hashToken(raw);
  const expiresAt = expiresDays ? Date.now() + expiresDays * 86400_000 : null;
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO api_tokens (user_id, token_hash, name, expires_at) VALUES (?, ?, ?, ?)"
  ).run(userId, hash, name, expiresAt);
  return {
    raw,
    record: {
      id: Number(info.lastInsertRowid),
      user_id: userId,
      name,
      last_used_at: null,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    },
  };
}

export type MobileSession = { uid: number; sub: string; role: Role; tokenId: number };

/** 从 Bearer token 解析用户身份。成功则更新 last_used_at */
export function verifyApiToken(raw: string): MobileSession | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(raw);
  const db = getDb();
  const row = db.prepare(`
    SELECT t.id AS token_id, t.user_id, t.expires_at,
           u.username, u.role
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hash) as {
    token_id: number; user_id: number; expires_at: number | null;
    username: string; role: string;
  } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  // 更新 last_used_at（异步不影响响应延迟）
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.token_id);
  return {
    uid: row.user_id,
    sub: row.username,
    role: (row.role === "viewer" ? "viewer" : "admin") as Role,
    tokenId: row.token_id,
  };
}

/** 吊销一个 token */
export function revokeApiToken(tokenId: number, userId: number): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(tokenId, userId);
  return info.changes > 0;
}

/** 列出用户的所有 token（不含 hash） */
export function listApiTokens(userId: number) {
  const db = getDb();
  return db.prepare(
    "SELECT id, user_id, name, last_used_at, expires_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY id"
  ).all(userId) as Omit<ApiToken, "token_hash">[];
}

/* ───── 从 Request 提取 Bearer token ───── */

export function readBearerToken(req: Request): MobileSession | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return verifyApiToken(auth.slice(7));
}

export function requireMobileAuth(req: Request): MobileSession | Response {
  const s = readBearerToken(req);
  if (!s) return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401, headers: { "content-type": "application/json" },
  });
  return s;
}

/* ───── 权限查询：用户能看到哪些主机 ───── */

/** 返回该用户可看到的主机 id 集合。admin 返回 null 表示"全部可见"。 */
export function getAccessibleHostIds(userId: number, role: Role): Set<number> | null {
  if (role === "admin") return null; // admin 看全部
  const db = getDb();
  // 直接授权的 host_id
  const directRows = db.prepare(
    "SELECT host_id FROM user_host_access WHERE user_id = ? AND host_id IS NOT NULL"
  ).all(userId) as { host_id: number }[];
  // 通过 group 授权
  const groupRows = db.prepare(
    "SELECT group_id FROM user_host_access WHERE user_id = ? AND group_id IS NOT NULL"
  ).all(userId) as { group_id: number }[];

  const ids = new Set<number>(directRows.map((r) => r.host_id));

  if (groupRows.length > 0) {
    const groupIds = groupRows.map((r) => r.group_id);
    const placeholders = groupIds.map(() => "?").join(",");
    const hostRows = db.prepare(
      `SELECT id FROM hosts WHERE group_id IN (${placeholders})`
    ).all(...groupIds) as { id: number }[];
    for (const r of hostRows) ids.add(r.id);
  }

  return ids;
}

/** 过滤主机列表，只保留用户有权访问的（admin 不过滤） */
export function filterHostsByAccess(hosts: Host[], userId: number, role: Role): Host[] {
  const ids = getAccessibleHostIds(userId, role);
  if (ids === null) return hosts; // admin
  return hosts.filter((h) => ids.has(h.id));
}

/* ───── 权限管理（admin） ───── */

export function getUserHostAccess(userId: number): UserHostAccess[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM user_host_access WHERE user_id = ? ORDER BY id"
  ).all(userId) as UserHostAccess[];
}

export function addUserHostAccess(
  userId: number,
  hostId: number | null,
  groupId: number | null,
): UserHostAccess {
  const db = getDb();
  // 去重
  if (hostId != null) {
    const exist = db.prepare(
      "SELECT id FROM user_host_access WHERE user_id = ? AND host_id = ?"
    ).get(userId, hostId);
    if (exist) return db.prepare("SELECT * FROM user_host_access WHERE user_id = ? AND host_id = ?").get(userId, hostId) as UserHostAccess;
  }
  if (groupId != null) {
    const exist = db.prepare(
      "SELECT id FROM user_host_access WHERE user_id = ? AND group_id = ?"
    ).get(userId, groupId);
    if (exist) return db.prepare("SELECT * FROM user_host_access WHERE user_id = ? AND group_id = ?").get(userId, groupId) as UserHostAccess;
  }
  const info = db.prepare(
    "INSERT INTO user_host_access (user_id, host_id, group_id) VALUES (?, ?, ?)"
  ).run(userId, hostId, groupId);
  return db.prepare("SELECT * FROM user_host_access WHERE id = ?").get(Number(info.lastInsertRowid)) as UserHostAccess;
}

export function removeUserHostAccess(accessId: number): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM user_host_access WHERE id = ?").run(accessId).changes > 0;
}
