import { getDb, getSettings } from "./db";
import type { Host, HostMetrics, HostHistoryPoint } from "./types";
import { parseProm, getAll, getOne, sumWhere, type Sample } from "./prom-parser";
import { getSilenceMs, pruneAlertEvents, sendWebhookAndRecord } from "./alerts";

const TIMEOUT_MS = Number(process.env.HOST_TIMEOUT_MS || 5000);
const INTERVAL_MS = Number(process.env.HOST_INTERVAL_MS || 30_000);
const CONCURRENCY = Math.max(1, Number(process.env.HOST_CONCURRENCY || 8));
const HISTORY_SIZE = 60;
/** 连续 N 轮异常/恢复才翻转官方状态（防抖） */
const FAIL_THRESHOLD = 2;
const RECOVER_THRESHOLD = 2;
const RETENTION_DAYS = Number(process.env.HOST_RETENTION_DAYS || 7);

/** 匹配到即视为虚拟/环回网卡，跳过统计 */
const NODE_SKIP_IFACE = /^(lo|docker|veth|br-|virbr|tun|tap|cali|flannel|cni|kube-|dummy|bond|wg|vmnet|zt|tailscale)/i;
const WIN_SKIP_NIC = /(loopback|teredo|isatap|pseudo|wan[ _]miniport|bluetooth|tap|vethernet|virtual|vmware|hyper-?v)/i;

type CpuSnap = { idle: number; total: number; at: number };
type NetSnap = { rx: number; tx: number; at: number };

type AlertDim = "reachable" | "cpu" | "mem" | "disk";
type AlertKind = "down" | "up" | "cpu" | "mem" | "disk" | "recover_cpu" | "recover_mem" | "recover_disk";

type AlertMemo = {
  /** 已对外公布的"官方"稳定状态，true=正常 */
  state: Record<AlertDim, boolean>;
  /** 连续与当前官方状态相反的观测次数（达到阈值才翻转） */
  streak: Record<AlertDim, number>;
  /** 每种告警上次真正发送的时间戳（用于静默窗口） */
  lastFired: Partial<Record<AlertKind, number>>;
  initialized: boolean;
};

type State = {
  metrics: Record<number, HostMetrics>;
  history: Record<number, HostHistoryPoint[]>;
  prevCpu: Record<number, CpuSnap>;
  prevNet: Record<number, NetSnap>;
  alertMemo: Record<number, AlertMemo>;
  timer: NodeJS.Timeout | null;
  started: boolean;
  lastRunAt: number;
  running: boolean;
};

const G = globalThis as unknown as { __hostMonitor?: State };

function st(): State {
  if (!G.__hostMonitor) {
    G.__hostMonitor = {
      metrics: {}, history: {}, prevCpu: {}, prevNet: {}, alertMemo: {},
      timer: null, started: false, lastRunAt: 0, running: false,
    };
  }
  const s = G.__hostMonitor;
  s.metrics ??= {};
  s.history ??= {};
  s.prevCpu ??= {};
  s.prevNet ??= {};
  s.alertMemo ??= {};
  return s;
}

/** 简易并发池，保证任意时刻最多 limit 个任务在执行 */
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

function emptyMemo(): AlertMemo {
  return {
    state: { reachable: true, cpu: true, mem: true, disk: true },
    streak: { reachable: 0, cpu: 0, mem: 0, disk: 0 },
    lastFired: {},
    initialized: false,
  };
}

/* -------- 抓取 -------- */

async function fetchText(url: string, authHeader?: string | null): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "text/plain" };
    if (authHeader && authHeader.trim()) headers["authorization"] = authHeader.trim();
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* -------- 提取（node_exporter） -------- */

const PSEUDO_FS = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "proc", "sysfs", "cgroup", "cgroup2", "autofs", "fuse.gvfsd-fuse", "devpts", "mqueue"]);

function extractNode(samples: Sample[], hostId: number): HostMetrics {
  const state = st();
  const now = Date.now();

  // CPU：累加 idle / total
  const cpuTotal = sumWhere(samples, "node_cpu_seconds_total");
  const cpuIdle = sumWhere(samples, "node_cpu_seconds_total", (l) => l.mode === "idle");
  const prev = state.prevCpu[hostId];
  let cpu_pct: number | null = null;
  if (prev && cpuTotal > prev.total) {
    const dIdle = cpuIdle - prev.idle;
    const dTotal = cpuTotal - prev.total;
    cpu_pct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  state.prevCpu[hostId] = { idle: cpuIdle, total: cpuTotal, at: now };

  // 内存
  const memTotal = getOne(samples, "node_memory_MemTotal_bytes") ?? 0;
  let memAvail = getOne(samples, "node_memory_MemAvailable_bytes");
  if (memAvail == null) {
    const free = getOne(samples, "node_memory_MemFree_bytes") ?? 0;
    const buf = getOne(samples, "node_memory_Buffers_bytes") ?? 0;
    const cache = getOne(samples, "node_memory_Cached_bytes") ?? 0;
    memAvail = free + buf + cache;
  }
  const mem_used_bytes = Math.max(0, memTotal - (memAvail ?? 0));
  const mem_pct = memTotal > 0 ? (mem_used_bytes / memTotal) * 100 : null;

  // 磁盘
  const sizes = getAll(samples, "node_filesystem_size_bytes");
  const avails = getAll(samples, "node_filesystem_avail_bytes");
  const disks: HostMetrics["disks"] = [];
  for (const s of sizes) {
    const fstype = s.labels.fstype || "";
    const mount = s.labels.mountpoint || s.labels.mount_point || "";
    if (!mount) continue;
    if (PSEUDO_FS.has(fstype)) continue;
    if (mount.startsWith("/run") || mount.startsWith("/sys") || mount.startsWith("/proc") || mount.startsWith("/dev")) continue;
    if (s.value <= 0) continue;
    const av = avails.find((a) => a.labels.mountpoint === mount && a.labels.device === s.labels.device)?.value ?? 0;
    const used = Math.max(0, s.value - av);
    disks.push({
      mount,
      fstype,
      total_bytes: s.value,
      used_bytes: used,
      used_pct: (used / s.value) * 100,
    });
  }
  // 去重 & 排序：按 used_pct 降序
  const seen = new Set<string>();
  const uniqueDisks = disks.filter((d) => (seen.has(d.mount) ? false : (seen.add(d.mount), true)));
  uniqueDisks.sort((a, b) => b.used_pct - a.used_pct);

  const load1 = getOne(samples, "node_load1");
  const bootTime = getOne(samples, "node_boot_time_seconds");
  const uptime_seconds = bootTime ? Math.max(0, now / 1000 - bootTime) : undefined;

  // 网络：按设备汇总非虚拟网卡的 rx/tx字节计数器，通过 prevNet 算速率
  const rxTotal = sumWhere(samples, "node_network_receive_bytes_total", (l) => !NODE_SKIP_IFACE.test(l.device || ""));
  const txTotal = sumWhere(samples, "node_network_transmit_bytes_total", (l) => !NODE_SKIP_IFACE.test(l.device || ""));
  const { rx_bps, tx_bps } = computeNetRate(hostId, rxTotal, txTotal, now);

  return {
    ok: true,
    scrapedAt: now,
    cpu_pct: cpu_pct == null ? null : Math.round(cpu_pct * 10) / 10,
    mem_pct: mem_pct == null ? null : Math.round(mem_pct * 10) / 10,
    mem_used_bytes, mem_total_bytes: memTotal,
    load1: load1 == null ? null : Math.round(load1 * 100) / 100,
    uptime_seconds,
    rx_bps, tx_bps,
    disks: uniqueDisks,
    flavor: "node",
  };
}

function computeNetRate(hostId: number, rx: number, tx: number, now: number): { rx_bps: number | null; tx_bps: number | null } {
  const state = st();
  const prev = state.prevNet[hostId];
  let rx_bps: number | null = null;
  let tx_bps: number | null = null;
  if (prev && now > prev.at) {
    const dtSec = (now - prev.at) / 1000;
    // 计数器重置或回绕时丢弃本轮差值
    if (rx >= prev.rx) rx_bps = Math.round(Math.max(0, (rx - prev.rx) / dtSec));
    if (tx >= prev.tx) tx_bps = Math.round(Math.max(0, (tx - prev.tx) / dtSec));
  }
  state.prevNet[hostId] = { rx, tx, at: now };
  return { rx_bps, tx_bps };
}

/* -------- 提取（windows_exporter） -------- */

function extractWindows(samples: Sample[], hostId: number): HostMetrics {
  const state = st();
  const now = Date.now();

  // CPU：windows_cpu_time_total{mode="idle/..."} 累加
  const cpuTotal = sumWhere(samples, "windows_cpu_time_total");
  const cpuIdle = sumWhere(samples, "windows_cpu_time_total", (l) => l.mode === "idle");
  const prev = state.prevCpu[hostId];
  let cpu_pct: number | null = null;
  if (prev && cpuTotal > prev.total) {
    const dIdle = cpuIdle - prev.idle;
    const dTotal = cpuTotal - prev.total;
    cpu_pct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  state.prevCpu[hostId] = { idle: cpuIdle, total: cpuTotal, at: now };

  // 内存：windows_cs_physical_memory_bytes (total) - windows_os_physical_memory_free_bytes (free)
  const memTotal = getOne(samples, "windows_cs_physical_memory_bytes") ?? 0;
  const memFree = getOne(samples, "windows_os_physical_memory_free_bytes") ?? 0;
  const mem_used_bytes = Math.max(0, memTotal - memFree);
  const mem_pct = memTotal > 0 ? (mem_used_bytes / memTotal) * 100 : null;

  // 磁盘：windows_logical_disk_size_bytes / windows_logical_disk_free_bytes（按 volume）
  const sizes = getAll(samples, "windows_logical_disk_size_bytes");
  const frees = getAll(samples, "windows_logical_disk_free_bytes");
  const disks: HostMetrics["disks"] = [];
  for (const s of sizes) {
    const vol = s.labels.volume || s.labels.disk || "";
    if (!vol || vol === "_Total") continue;
    if (s.value <= 0) continue;
    const fr = frees.find((f) => (f.labels.volume || f.labels.disk) === vol)?.value ?? 0;
    const used = Math.max(0, s.value - fr);
    disks.push({
      mount: vol,
      total_bytes: s.value,
      used_bytes: used,
      used_pct: (used / s.value) * 100,
    });
  }
  disks.sort((a, b) => b.used_pct - a.used_pct);

  // 网络：windows_net_bytes_received_total / windows_net_bytes_sent_total，按 nic 汇总
  const rxTotal = sumWhere(samples, "windows_net_bytes_received_total", (l) => !WIN_SKIP_NIC.test(l.nic || ""));
  const txTotal = sumWhere(samples, "windows_net_bytes_sent_total", (l) => !WIN_SKIP_NIC.test(l.nic || ""));
  const { rx_bps, tx_bps } = computeNetRate(hostId, rxTotal, txTotal, now);

  // Windows 没有"负载"概念，留空
  return {
    ok: true,
    scrapedAt: now,
    cpu_pct: cpu_pct == null ? null : Math.round(cpu_pct * 10) / 10,
    mem_pct: mem_pct == null ? null : Math.round(mem_pct * 10) / 10,
    mem_used_bytes, mem_total_bytes: memTotal,
    load1: null,
    rx_bps, tx_bps,
    disks,
    flavor: "windows",
  };
}

/* -------- 调度 -------- */

async function scrapeOne(host: Host): Promise<HostMetrics> {
  try {
    const txt = await fetchText(host.exporter_url, host.auth_header);
    const samples = parseProm(txt);
    let flavor: "node" | "windows" = host.exporter_type === "windows" ? "windows" : host.exporter_type === "node" ? "node" : (samples.some((s) => s.name.startsWith("windows_")) ? "windows" : "node");
    const m = flavor === "windows" ? extractWindows(samples, host.id) : extractNode(samples, host.id);
    return m;
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message || "scrape failed",
      scrapedAt: Date.now(),
      cpu_pct: null, mem_pct: null, load1: null, disks: [],
    };
  }
}

async function maybeAlert(host: Host, m: HostMetrics) {
  if (!host.alerts_enabled) return;
  const settings = getSettings(getDb());
  const url = (settings.alert_webhook_url || "").trim();
  if (!url) return;

  const state = st();
  const id = host.id;
  const memo = (state.alertMemo[id] ??= emptyMemo());

  // 计算本轮各维度的"真实观测"（true=正常）
  const cpuOk = m.cpu_pct == null || m.cpu_pct < host.cpu_threshold;
  const memOk = m.mem_pct == null || m.mem_pct < host.mem_threshold;
  const worstDiskPct = m.disks.length ? Math.max(...m.disks.map((d) => d.used_pct)) : 0;
  const diskOk = worstDiskPct < host.disk_threshold;
  const obs: Record<AlertDim, boolean> = {
    reachable: m.ok,
    // 主机不可达时无法获取这些指标，视作保持原有状态
    cpu: m.ok ? cpuOk : memo.state.cpu,
    mem: m.ok ? memOk : memo.state.mem,
    disk: m.ok ? diskOk : memo.state.disk,
  };

  // 首次初始化：以当前观测为基准，不触发任何告警
  if (!memo.initialized) {
    memo.state = { ...obs };
    memo.streak = { reachable: 0, cpu: 0, mem: 0, disk: 0 };
    memo.initialized = true;
    return;
  }

  const flips = (Object.keys(obs) as AlertDim[]).filter((dim) => {
    if (obs[dim] === memo.state[dim]) {
      memo.streak[dim] = 0;
      return false;
    }
    memo.streak[dim] += 1;
    const needed = obs[dim] ? RECOVER_THRESHOLD : FAIL_THRESHOLD;
    if (memo.streak[dim] < needed) return false;
    memo.state[dim] = obs[dim];
    memo.streak[dim] = 0;
    return true;
  });

  if (flips.length === 0) return;

  type AlertSpec = { kind: AlertKind; text: string };
  const fires: AlertSpec[] = [];
  for (const dim of flips) {
    const good = memo.state[dim];
    if (dim === "reachable") {
      fires.push(good
        ? { kind: "up",   text: `🟢 ${host.name} 已恢复` }
        : { kind: "down", text: `🔴 ${host.name} 不可达：${m.error || "scrape error"}` });
    } else if (dim === "cpu") {
      fires.push(good
        ? { kind: "recover_cpu", text: `🟢 ${host.name} CPU 已恢复正常 (${m.cpu_pct ?? "-"}%)` }
        : { kind: "cpu",         text: `⚠️ ${host.name} CPU ${m.cpu_pct ?? "-"}% 超阈值 ${host.cpu_threshold}%` });
    } else if (dim === "mem") {
      fires.push(good
        ? { kind: "recover_mem", text: `🟢 ${host.name} 内存已恢复正常 (${m.mem_pct ?? "-"}%)` }
        : { kind: "mem",         text: `⚠️ ${host.name} 内存 ${m.mem_pct ?? "-"}% 超阈值 ${host.mem_threshold}%` });
    } else {
      fires.push(good
        ? { kind: "recover_disk", text: `🟢 ${host.name} 磁盘已恢复正常 (${worstDiskPct.toFixed(1)}%)` }
        : { kind: "disk",         text: `⚠️ ${host.name} 磁盘 ${worstDiskPct.toFixed(1)}% 超阈值 ${host.disk_threshold}%` });
    }
  }

  const now = Date.now();
  const silence = getSilenceMs("host");
  for (const a of fires) {
    const last = memo.lastFired[a.kind] ?? 0;
    if (now - last < silence) continue;
    memo.lastFired[a.kind] = now;
    const payload = {
      kind: `host_${a.kind}`,
      host: { id: host.id, name: host.name, exporter_url: host.exporter_url },
      metrics: { cpu_pct: m.cpu_pct, mem_pct: m.mem_pct, load1: m.load1, worst_disk_pct: worstDiskPct },
      at: new Date(m.scrapedAt).toISOString(),
      text: a.text,
      content: a.text,
      msgtype: "text",
      msg_type: "text",
      text_content: a.text,
    };
    void sendWebhookAndRecord(url, payload, {
      at: now,
      source: "host",
      kind: a.kind,
      targetId: host.id,
      targetName: host.name,
      text: a.text,
    });
  }
}

export async function runOnce(): Promise<void> {
  const state = st();
  if (state.running) return;
  state.running = true;
  try {
    const db = getDb();
    const hosts = db.prepare("SELECT * FROM hosts WHERE enabled = 1").all() as Host[];
    const results = await runPool(hosts, CONCURRENCY, async (h) => [h, await scrapeOne(h)] as const);
    const seen = new Set<number>();
    const insertSample = db.prepare(
      "INSERT OR REPLACE INTO host_samples (host_id, at, cpu, mem, load1, disk) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertMany = db.transaction((rows: Array<[number, number, number | null, number | null, number | null, number | null]>) => {
      for (const r of rows) insertSample.run(...r);
    });
    const toPersist: Array<[number, number, number | null, number | null, number | null, number | null]> = [];
    for (const [h, m] of results) {
      seen.add(h.id);
      state.metrics[h.id] = m;
      const hist = state.history[h.id] ?? [];
      hist.push({ at: m.scrapedAt, cpu: m.cpu_pct, mem: m.mem_pct });
      while (hist.length > HISTORY_SIZE) hist.shift();
      state.history[h.id] = hist;
      // 只在抓取成功（且 CPU 已有差值）时落库，避免噪点
      if (m.ok) {
        const worstDisk = m.disks.length ? Math.max(...m.disks.map((d) => d.used_pct)) : null;
        toPersist.push([h.id, m.scrapedAt, m.cpu_pct, m.mem_pct, m.load1, worstDisk]);
      }
      void maybeAlert(h, m);
    }
    if (toPersist.length) {
      try { insertMany(toPersist); } catch { /* ignore */ }
    }
    // 保留期清理
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
      db.prepare("DELETE FROM host_samples WHERE at < ?").run(cutoff);
    } catch { /* ignore */ }
    pruneAlertEvents();
    // 清理已删除的 host 缓存
    for (const k of Object.keys(state.metrics)) {
      const id = Number(k);
      if (!seen.has(id)) {
        delete state.metrics[id];
        delete state.history[id];
        delete state.prevCpu[id];
        delete state.prevNet[id];
        delete state.alertMemo[id];
      }
    }
    state.lastRunAt = Date.now();
  } finally {
    state.running = false;
  }
}

export function ensureHostMonitor() {
  const state = st();
  if (state.started) return;
  state.started = true;
  void runOnce().catch(() => {});
  state.timer = setInterval(() => { void runOnce().catch(() => {}); }, INTERVAL_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

export function getAllMetrics(): Record<number, HostMetrics> {
  ensureHostMonitor();
  return st().metrics;
}

export function getAllHostHistory(): Record<number, HostHistoryPoint[]> {
  ensureHostMonitor();
  return st().history;
}

/** 查询某主机的历史采样，按 bucket 聚合 */
export type HistoryRange = "1h" | "6h" | "24h" | "7d";

export function queryHostHistory(hostId: number, range: HistoryRange): Array<{ at: number; cpu: number | null; mem: number | null; load1: number | null; disk: number | null }> {
  const map: Record<HistoryRange, { windowMs: number; bucketMs: number }> = {
    "1h":  { windowMs: 60 * 60 * 1000,       bucketMs: 60 * 1000 },
    "6h":  { windowMs: 6 * 60 * 60 * 1000,   bucketMs: 6 * 60 * 1000 },
    "24h": { windowMs: 24 * 60 * 60 * 1000,  bucketMs: 24 * 60 * 1000 },
    "7d":  { windowMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 168 * 60 * 1000 },
  };
  const { windowMs, bucketMs } = map[range];
  const since = Date.now() - windowMs;
  const db = getDb();
  const rows = db.prepare(
    `SELECT CAST((at / ?) * ? AS INTEGER) AS bucket,
            AVG(cpu) AS cpu,
            AVG(mem) AS mem,
            AVG(load1) AS load1,
            AVG(disk) AS disk
       FROM host_samples
      WHERE host_id = ? AND at >= ?
      GROUP BY bucket
      ORDER BY bucket`
  ).all(bucketMs, bucketMs, hostId, since) as Array<{ bucket: number; cpu: number | null; mem: number | null; load1: number | null; disk: number | null }>;
  return rows.map((r) => ({ at: r.bucket, cpu: r.cpu, mem: r.mem, load1: r.load1, disk: r.disk }));
}

/** 即时探测一个 URL（用于"测试连接"按钮，不写入持久化状态） */
export async function probeOnce(url: string, type: "auto" | "node" | "windows" = "auto", authHeader: string | null = null): Promise<HostMetrics> {
  // 用 -1 临时 id 防止污染真正的 prevCpu / prevNet
  const fakeHost: Host = {
    id: -1, group_id: null, name: "probe", exporter_url: url, exporter_type: type,
    enabled: 1, is_private: 0, alerts_enabled: 0,
    cpu_threshold: 90, mem_threshold: 90, disk_threshold: 90,
    description: null, auth_header: authHeader, sort_order: 0, created_at: "", updated_at: "",
  };
  const m1 = await scrapeOne(fakeHost);
  // CPU 第一次没有差值，等 1.5 秒再来一次拿到真正的 cpu_pct
  if (m1.ok && m1.cpu_pct == null) {
    await new Promise((r) => setTimeout(r, 1500));
    return await scrapeOne(fakeHost);
  }
  return m1;
}
