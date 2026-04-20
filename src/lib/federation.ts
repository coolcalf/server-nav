/**
 * 联邦模式 —— 支持 master / agent 两种角色。
 *
 * master：接收各 agent 推送的快照，存在内存中供前端展示。
 * agent ：定时将本地 hosts / services 数据推送到 master。
 */

import type { Host, HostMetrics, HostHistoryPoint, Service, Category } from "./types";
import type { HealthStatus } from "./health-monitor";

/* ================================================================
   公共类型
   ================================================================ */

export type FederationMode = "standalone" | "master" | "agent";

/** agent → master 推送的数据包 */
export type AgentPushPayload = {
  agent_key: string;
  hosts: Host[];
  host_metrics: Record<string, HostMetrics>;
  host_history: Record<string, HostHistoryPoint[]>;
  services: Service[];
  categories: Category[];
  service_statuses: Record<string, HealthStatus>;
  service_history: Record<string, (number | null)[]>;
};

/** master 侧存储的每个 agent 快照 */
export type AgentSnapshot = {
  agentId: string;
  agentName: string;
  receivedAt: number;
  hosts: Host[];
  hostMetrics: Record<string, HostMetrics>;
  hostHistory: Record<string, HostHistoryPoint[]>;
  services: Service[];
  categories: Category[];
  serviceStatuses: Record<string, HealthStatus>;
  serviceHistory: Record<string, (number | null)[]>;
};

/** 数据库 agents 行 */
export type AgentRow = {
  id: string;
  name: string;
  key_hash: string;
  enabled: number;
  public_visible: number;
  last_seen_at: number | null;
  sort_order: number;
  created_at: string;
};

/* ================================================================
   通用辅助
   ================================================================ */

export function getFederationMode(): FederationMode {
  const raw = (process.env.FEDERATION_MODE || "standalone").trim().toLowerCase();
  if (raw === "master" || raw === "agent") return raw;
  return "standalone";
}

export function isMaster(): boolean {
  return getFederationMode() === "master";
}

export function isAgent(): boolean {
  return getFederationMode() === "agent";
}

/* ================================================================
   Master 侧 —— 内存存储
   ================================================================ */

const MG = globalThis as unknown as { __federationMaster?: MasterState };

type MasterState = {
  snapshots: Record<string, AgentSnapshot>;
};

function masterState(): MasterState {
  if (!MG.__federationMaster) {
    MG.__federationMaster = { snapshots: {} };
  }
  return MG.__federationMaster;
}

/** master 收到一个 agent 的推送后调用 */
export function upsertSnapshot(agentId: string, agentName: string, payload: AgentPushPayload) {
  const st = masterState();
  st.snapshots[agentId] = {
    agentId,
    agentName,
    receivedAt: Date.now(),
    hosts: payload.hosts,
    hostMetrics: payload.host_metrics,
    hostHistory: payload.host_history,
    services: payload.services,
    categories: payload.categories,
    serviceStatuses: payload.service_statuses,
    serviceHistory: payload.service_history,
  };
}

/** 获取所有 agent 最新快照 */
export function getAllSnapshots(): AgentSnapshot[] {
  return Object.values(masterState().snapshots);
}

/** 获取单个 agent 快照 */
export function getSnapshot(agentId: string): AgentSnapshot | undefined {
  return masterState().snapshots[agentId];
}

/** 删除某 agent 的缓存快照 */
export function removeSnapshot(agentId: string) {
  delete masterState().snapshots[agentId];
}

/** 返回 public_visible=1 的 agent ID 集合（用于未登录用户过滤） */
export function getPublicVisibleAgentIds(): Set<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("./db") as typeof import("./db");
    const db = getDb();
    const rows = db.prepare("SELECT id FROM agents WHERE public_visible = 1 AND enabled = 1").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

/** 返回 agent_id → public_visible 映射（仅 enabled 的） */
export function getAgentPublicVisibleMap(): Map<string, boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("./db") as typeof import("./db");
    const rows = getDb()
      .prepare("SELECT id, public_visible FROM agents WHERE enabled = 1")
      .all() as { id: string; public_visible: number }[];
    return new Map(rows.map((r) => [r.id, !!r.public_visible]));
  } catch { return new Map(); }
}

/* ---- 单项可见性覆盖 ---- */

export type ItemVisibility = { agent_id: string; item_type: "host" | "service"; remote_id: number; public_visible: number };

/**
 * 获取指定 agent 的单项可见性覆盖列表。
 * 返回 Map<`${item_type}:${remote_id}`, public_visible>。
 */
export function getItemOverrides(agentId: string): Map<string, boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("./db") as typeof import("./db");
    const rows = getDb()
      .prepare("SELECT item_type, remote_id, public_visible FROM agent_item_visibility WHERE agent_id = ?")
      .all(agentId) as ItemVisibility[];
    const m = new Map<string, boolean>();
    for (const r of rows) m.set(`${r.item_type}:${r.remote_id}`, !!r.public_visible);
    return m;
  } catch { return new Map(); }
}

/** 获取所有 agent 的单项可见性覆盖（批量查询，性能更好） */
export function getAllItemOverrides(): Map<string, Map<string, boolean>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("./db") as typeof import("./db");
    const rows = getDb()
      .prepare("SELECT agent_id, item_type, remote_id, public_visible FROM agent_item_visibility")
      .all() as ItemVisibility[];
    const out = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      let m = out.get(r.agent_id);
      if (!m) { m = new Map(); out.set(r.agent_id, m); }
      m.set(`${r.item_type}:${r.remote_id}`, !!r.public_visible);
    }
    return out;
  } catch { return new Map(); }
}

/** 设置单项可见性覆盖 */
export function setItemVisibility(agentId: string, itemType: "host" | "service", remoteId: number, publicVisible: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("./db") as typeof import("./db");
  getDb().prepare(
    "INSERT INTO agent_item_visibility (agent_id, item_type, remote_id, public_visible) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, item_type, remote_id) DO UPDATE SET public_visible = excluded.public_visible"
  ).run(agentId, itemType, remoteId, publicVisible ? 1 : 0);
}

/** 删除单项覆盖（恢复为跟随节点默认） */
export function removeItemVisibility(agentId: string, itemType: "host" | "service", remoteId: number): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("./db") as typeof import("./db");
  getDb().prepare(
    "DELETE FROM agent_item_visibility WHERE agent_id = ? AND item_type = ? AND remote_id = ?"
  ).run(agentId, itemType, remoteId);
}

/**
 * 判断某个远程项目对未登录用户是否可见。
 * 逻辑：有 override 用 override，否则跟随 agent 的 public_visible。
 */
export function isItemPublic(agentPublicVisible: boolean, overrides: Map<string, boolean>, itemType: "host" | "service", remoteId: number): boolean {
  const key = `${itemType}:${remoteId}`;
  const override = overrides.get(key);
  if (override !== undefined) return override;
  return agentPublicVisible;
}

/* ================================================================
   Agent 侧 —— 定时推送
   ================================================================ */

const AG = globalThis as unknown as { __federationAgent?: AgentState };

type AgentState = {
  timer: NodeJS.Timeout | null;
  started: boolean;
  lastPushAt: number;
  lastError: string | null;
  pushing: boolean;
};

function agentState(): AgentState {
  if (!AG.__federationAgent) {
    AG.__federationAgent = { timer: null, started: false, lastPushAt: 0, lastError: null, pushing: false };
  }
  return AG.__federationAgent;
}

async function pushOnce() {
  const st = agentState();
  if (st.pushing) return;
  st.pushing = true;
  try {
    const masterUrl = (process.env.MASTER_URL || "").replace(/\/+$/, "");
    const agentKey = process.env.AGENT_KEY || "";
    if (!masterUrl || !agentKey) {
      st.lastError = "MASTER_URL or AGENT_KEY not configured";
      return;
    }

    // 延迟 import 避免循环依赖
    const { getDb } = await import("./db");
    const { getAllMetrics, getAllHostHistory, ensureHostMonitor } = await import("./host-monitor");
    const { getAllStatuses, getAllHistory, ensureHealthMonitor } = await import("./health-monitor");

    const db = getDb();
    ensureHostMonitor();
    ensureHealthMonitor();

    const hosts = db.prepare("SELECT * FROM hosts WHERE enabled = 1").all() as Host[];
    const services = db.prepare("SELECT * FROM services").all() as Service[];
    const categories = db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all() as Category[];

    const hostMetrics = getAllMetrics();
    const hostHistory = getAllHostHistory();
    const serviceStatuses = getAllStatuses();
    const serviceHistory = getAllHistory();

    // 清理敏感字段：不推送 credentials、auth_header
    const cleanHosts = hosts.map((h) => ({ ...h, auth_header: null }));
    const cleanServices = services.map((s) => ({
      ...s,
      credentials: null,
      notes: null,
      internal_url: null,
    }));

    const payload: AgentPushPayload = {
      agent_key: agentKey,
      hosts: cleanHosts,
      host_metrics: toStringKeyRecord(hostMetrics),
      host_history: toStringKeyRecord(hostHistory),
      services: cleanServices,
      categories,
      service_statuses: toStringKeyRecord(serviceStatuses),
      service_history: toStringKeyRecord(serviceHistory),
    };

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(`${masterUrl}/api/federation/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        st.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      } else {
        st.lastError = null;
        st.lastPushAt = Date.now();
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    st.lastError = (e as Error).message || "push failed";
  } finally {
    st.pushing = false;
  }
}

/** 在 agent 模式下启动推送定时器（幂等） */
export function ensureAgentPush() {
  if (!isAgent()) return;
  const st = agentState();
  if (st.started) return;
  st.started = true;
  const interval = Number(process.env.AGENT_PUSH_INTERVAL_MS || 30_000);
  // 首次延迟 5 秒等本地监控先跑一轮
  setTimeout(() => {
    void pushOnce().catch(() => {});
    st.timer = setInterval(() => { void pushOnce().catch(() => {}); }, interval);
    if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
  }, 5_000);
}

/** 获取 agent 推送状态（前端展示用） */
export function getAgentStatus() {
  const st = agentState();
  return {
    mode: "agent" as const,
    masterUrl: process.env.MASTER_URL || "",
    agentName: process.env.AGENT_NAME || require("os").hostname(),
    lastPushAt: st.lastPushAt,
    lastError: st.lastError,
    pushing: st.pushing,
  };
}

/* ================================================================
   工具函数
   ================================================================ */

function toStringKeyRecord<V>(obj: Record<number, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(obj)) out[String(k)] = v;
  return out;
}
