import net from "node:net";
import { getDb, getSettings } from "./db";
import type { Service } from "./types";
import { getSilenceMs, sendWebhookAndRecord } from "./alerts";

export type HealthStatus = {
  ok: boolean;
  latency: number | null;
  error?: string;
  status?: number; // HTTP 状态码
  checkedAt: number;
  type: "http" | "tcp" | "none";
};

type StatusMap = Record<number, HealthStatus>;
/** 每个服务最近 N 次延迟采样（null = 不在线） */
type HistoryMap = Record<number, (number | null)[]>;

type MonitorState = {
  map: StatusMap;
  history: HistoryMap;
  /** 连续失败计数，用于触发告警前的防抖 */
  failStreak: Record<number, number>;
  /** 连续成功计数，用于恢复告警前的防抖 */
  okStreak: Record<number, number>;
  /** 上次发送告警时的"已知稳定状态"（true=up / false=down） */
  lastAlertState: Record<number, boolean>;
  /** 每个服务上次各类告警发送的时间戳，用于静默窗口 */
  lastFired: Record<number, Partial<Record<"down" | "up", number>>>;
  timer: NodeJS.Timeout | null;
  started: boolean;
  lastRunAt: number;
  running: boolean;
};

const G = globalThis as unknown as { __healthMonitor?: MonitorState };

function state(): MonitorState {
  if (!G.__healthMonitor) {
    G.__healthMonitor = {
      map: {}, history: {}, failStreak: {}, okStreak: {}, lastAlertState: {}, lastFired: {},
      timer: null, started: false, lastRunAt: 0, running: false,
    };
  }
  // HMR/升级兼容：为旧版缓存补齐新字段
  const s = G.__healthMonitor;
  s.map ??= {};
  s.history ??= {};
  s.failStreak ??= {};
  s.okStreak ??= {};
  s.lastAlertState ??= {};
  s.lastFired ??= {};
  return s;
}

const HISTORY_SIZE = 20;
const FAIL_THRESHOLD = 2;      // 连续 N 次失败才算真掉线（防抖）
const RECOVER_THRESHOLD = 2;   // 连续 N 次成功才算真恢复（防抖）

const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 5000);
const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 30_000);
const CONCURRENCY = Math.max(1, Number(process.env.HEALTH_CONCURRENCY || 16));

/** 简易并发池 */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const size = Math.min(limit, items.length) || 1;
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

function deriveHostPort(input: string): { host: string; port: number } | null {
  const mHp = /^([^\s/:]+):(\d{1,5})$/.exec(input.trim());
  if (mHp) {
    const port = Number(mHp[2]);
    if (port > 0 && port < 65536) return { host: mHp[1], port };
  }
  try {
    const u = new URL(input);
    const host = u.hostname;
    let port = u.port ? Number(u.port) : NaN;
    if (!port) {
      const defaults: Record<string, number> = {
        "http:": 80, "https:": 443, "ftp:": 21, "ssh:": 22,
        "mysql:": 3306, "postgres:": 5432, "postgresql:": 5432,
        "redis:": 6379, "mongodb:": 27017, "mongodb+srv:": 27017,
      };
      port = defaults[u.protocol] ?? NaN;
    }
    if (host && port > 0) return { host, port };
  } catch { /* ignore */ }
  return null;
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; latency: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve({ ok, latency: Date.now() - start, error });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, (e as Error).message));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, (e as Error).message);
    }
  });
}

async function probeHttp(url: string): Promise<{ ok: boolean; latency: number; status?: number; error?: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow", cache: "no-store" });
    return { ok: res.status < 500, status: res.status, latency: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function probeService(s: Service): Promise<HealthStatus> {
  const type = (s.check_type as HealthStatus["type"]) || "http";
  const checkedAt = Date.now();
  if (type === "none") return { ok: true, latency: null, checkedAt, type };

  const target = s.check_target || s.url;
  if (type === "tcp") {
    const hp = deriveHostPort(target);
    if (!hp) return { ok: false, latency: null, error: "无法解析 host:port", checkedAt, type };
    const r = await probeTcp(hp.host, hp.port);
    return { ok: r.ok, latency: r.latency, error: r.error, checkedAt, type };
  }
  // http
  try { new URL(target); } catch {
    return { ok: false, latency: null, error: "invalid url", checkedAt, type };
  }
  const r = await probeHttp(target);
  return { ok: r.ok, latency: r.latency, status: r.status, error: r.error, checkedAt, type };
}

async function maybeAlert(service: Service, r: HealthStatus) {
  const st = state();
  const id = service.id;

  // 更新连续失败 / 成功计数
  if (r.ok) {
    st.okStreak[id] = (st.okStreak[id] ?? 0) + 1;
    st.failStreak[id] = 0;
  } else {
    st.failStreak[id] = (st.failStreak[id] ?? 0) + 1;
    st.okStreak[id] = 0;
  }

  const isDown = !r.ok && (st.failStreak[id] ?? 0) >= FAIL_THRESHOLD;
  const isUp = r.ok && (st.okStreak[id] ?? 0) >= RECOVER_THRESHOLD;

  // 初始化稳定状态（避免启动时瞬间闪告警）
  if (!(id in st.lastAlertState)) {
    st.lastAlertState[id] = isDown ? false : true;
    return;
  }
  const prevUp = st.lastAlertState[id];

  if (prevUp && isDown) {
    st.lastAlertState[id] = false;
    await fireAlert(service, r, "down");
  } else if (!prevUp && isUp) {
    st.lastAlertState[id] = true;
    await fireAlert(service, r, "up");
  }
}

async function fireAlert(service: Service, r: HealthStatus, kind: "down" | "up") {
  const settings = getSettings(getDb());
  const url = (settings.alert_webhook_url || "").trim();
  if (!url) return;
  // 静默窗口：同一服务同种告警短时间内不重复触发
  const st = state();
  const memo = (st.lastFired[service.id] ??= {});
  const now = Date.now();
  const silence = getSilenceMs("health");
  if (memo[kind] && now - memo[kind]! < silence) return;
  memo[kind] = now;
  const emoji = kind === "down" ? "🔴" : "🟢";
  const text = kind === "down"
    ? `${emoji} ${service.name} 不可达（${r.type.toUpperCase()} ${service.check_target || service.url}）${r.error ? ` · ${r.error}` : ""}`
    : `${emoji} ${service.name} 已恢复（${r.type.toUpperCase()}，${r.latency ?? "-"}ms）`;
  // 兼容常见 webhook：同时发送 text、content、msgtype、embed 字段，无害冗余
  const payload = {
    kind,
    service: {
      id: service.id, name: service.name, url: service.url,
      target: service.check_target || service.url, type: r.type,
    },
    latency: r.latency,
    status: r.status ?? null,
    error: r.error ?? null,
    at: new Date().toISOString(),
    text,
    content: text,
    msgtype: "text",
    msg_type: "text",
    text_content: text,
  };
  await sendWebhookAndRecord(url, payload, {
    at: now,
    source: "service",
    kind,
    targetId: service.id,
    targetName: service.name,
    text,
  });
}

/** 跑一轮检查，使用 runPool 限制并发，避免大量服务时同时打满 */
export async function runOnce(): Promise<void> {
  const st = state();
  if (st.running) return;
  st.running = true;
  try {
    const db = getDb();
    const services = db.prepare("SELECT * FROM services").all() as Service[];
    const results = await runPool(services, CONCURRENCY, async (s) => [s, await probeService(s)] as const);
    const next: StatusMap = {};
    const existingIds = new Set<number>();
    for (const [s, r] of results) {
      existingIds.add(s.id);
      next[s.id] = r;

      // 更新历史
      const type = (s.check_type as HealthStatus["type"]) || "http";
      if (type !== "none") {
        const h = st.history[s.id] ?? [];
        h.push(r.ok ? (r.latency ?? 0) : null);
        while (h.length > HISTORY_SIZE) h.shift();
        st.history[s.id] = h;

        // 告警（不阻塞轮询）；每条服务可单独关闭
        if ((s.alerts_enabled ?? 1) !== 0) void maybeAlert(s, r);
      }
    }
    // 清理已删除服务的缓存
    for (const k of Object.keys(st.history)) {
      const id = Number(k);
      if (!existingIds.has(id)) {
        delete st.history[id];
        delete st.failStreak[id];
        delete st.okStreak[id];
        delete st.lastAlertState[id];
        delete st.lastFired[id];
      }
    }
    st.map = next;
    st.lastRunAt = Date.now();
  } finally {
    st.running = false;
  }
}

/** 启动定时器（多次调用幂等） */
export function ensureHealthMonitor() {
  const st = state();
  if (st.started) return;
  st.started = true;
  // 启动时先跑一次（异步，不阻塞）
  void runOnce().catch(() => {});
  st.timer = setInterval(() => { void runOnce().catch(() => {}); }, INTERVAL_MS);
  // 避免进程残留
  if (typeof st.timer.unref === "function") st.timer.unref();
}

export function getAllStatuses(): StatusMap {
  ensureHealthMonitor();
  return state().map;
}

export function getAllHistory(): HistoryMap {
  ensureHealthMonitor();
  return state().history;
}

export function getLastRunAt(): number {
  return state().lastRunAt;
}

/** 触发单条服务的即时检查并更新缓存（不等全局轮询） */
export async function probeById(id: number): Promise<HealthStatus | null> {
  const db = getDb();
  const s = db.prepare("SELECT * FROM services WHERE id = ?").get(id) as Service | undefined;
  if (!s) return null;
  const r = await probeService(s);
  state().map[id] = r;
  return r;
}
