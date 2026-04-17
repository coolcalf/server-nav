"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, RefreshCw, Server, Cpu, MemoryStick, HardDrive, Activity, AlertTriangle, Lock, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import type { Host, HostMetrics } from "@/lib/types";
import { TimeSeriesChart, type Series } from "./time-series-chart";

type Point = { at: number; cpu: number | null; mem: number | null; load1: number | null; disk: number | null };
type Range = "1h" | "6h" | "24h" | "7d";

const RANGES: { key: Range; label: string }[] = [
  { key: "1h", label: "1 小时" },
  { key: "6h", label: "6 小时" },
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
];

export function HostDetailClient({
  host, initialMetrics, initialPoints, authed,
}: {
  host: Host;
  initialMetrics?: HostMetrics;
  initialPoints: Point[];
  authed: boolean;
}) {
  const [metrics, setMetrics] = useState<HostMetrics | undefined>(initialMetrics);
  const [range, setRange] = useState<Range>("1h");
  const [points, setPoints] = useState<Point[]>(initialPoints);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async (r: Range) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hosts/${host.id}/history?range=${r}`, { cache: "no-store" });
      const j = await res.json();
      if (Array.isArray(j?.points)) setPoints(j.points);
    } finally { setLoading(false); }
  }, [host.id]);

  const loadCurrent = useCallback(async () => {
    const r = await fetch(`/api/hosts/metrics`, { cache: "no-store" });
    const j = await r.json();
    const m = j?.metrics?.[host.id];
    if (m) setMetrics(m);
  }, [host.id]);

  useEffect(() => {
    const t = setInterval(() => {
      void loadCurrent();
      void loadHistory(range);
    }, 30_000);
    return () => clearInterval(t);
  }, [loadCurrent, loadHistory, range]);

  function selectRange(r: Range) {
    setRange(r);
    void loadHistory(r);
  }

  async function manualRefresh() {
    await Promise.all([loadCurrent(), loadHistory(range)]);
  }

  const m = metrics;
  const ok = !!m?.ok;
  const worstDisk = m?.disks?.length ? Math.max(...m.disks.map((d) => d.used_pct)) : 0;
  const cpuAlert = ok && m.cpu_pct != null && m.cpu_pct >= host.cpu_threshold;
  const memAlert = ok && m.mem_pct != null && m.mem_pct >= host.mem_threshold;
  const diskAlert = ok && worstDisk >= host.disk_threshold;

  const cpuSeries: Series[] = [{
    name: "CPU",
    color: "rgb(56 189 248)",
    data: points.map((p) => ({ at: p.at, v: p.cpu })),
  }];
  const memSeries: Series[] = [{
    name: "内存",
    color: "rgb(168 85 247)",
    data: points.map((p) => ({ at: p.at, v: p.mem })),
  }];
  const loadSeries: Series[] = [{
    name: "Load 1m",
    color: "rgb(34 197 94)",
    data: points.map((p) => ({ at: p.at, v: p.load1 })),
  }];
  const diskSeries: Series[] = [{
    name: "最高磁盘占用",
    color: "rgb(249 115 22)",
    data: points.map((p) => ({ at: p.at, v: p.disk })),
  }];

  return (
    <>
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <Link href="/hosts" className="btn btn-ghost">
          <ArrowLeft size={14} /> <span className="hidden sm:inline">返回主机列表</span>
        </Link>
        <div className="flex-1" />
        <a href={host.exporter_url} target="_blank" rel="noreferrer" className="btn btn-outline">
          <ExternalLink size={14} /> /metrics
        </a>
        <button className="btn btn-ghost !w-9 !h-9 !p-0" onClick={manualRefresh} title="立即刷新">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="card-surface p-5 mb-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-muted shrink-0">
            <Server size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-semibold">{host.name}</h1>
              <span className={`dot ${ok ? "dot-ok" : !m ? "dot-pending" : "dot-bad"}`} title={ok ? "在线" : (m?.error || "未知")} />
              {host.is_private ? <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"><Lock size={10} />私有</span> : null}
              {!host.enabled ? <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">已停用</span> : null}
              {(cpuAlert || memAlert || diskAlert) ? <span className="text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"><AlertTriangle size={10} />超阈值</span> : null}
            </div>
            {host.description ? <p className="text-sm text-muted-foreground mt-1">{host.description}</p> : null}
            <div className="text-xs text-muted-foreground mt-1 break-all">
              {host.exporter_url}
              {m?.flavor ? <> · {m.flavor}</> : null}
              {m?.scrapedAt ? <> · 采样 {new Date(m.scrapedAt).toLocaleTimeString()}</> : null}
            </div>
          </div>
        </div>

        {/* 当前值摘要 */}
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatBox label="CPU" value={m?.cpu_pct != null ? `${m.cpu_pct.toFixed(1)}%` : "-"} icon={<Cpu size={12} />} danger={cpuAlert} threshold={`阈值 ${host.cpu_threshold}%`} />
          <StatBox label="内存" value={m?.mem_pct != null ? `${m.mem_pct.toFixed(1)}%` : "-"} icon={<MemoryStick size={12} />} danger={memAlert} threshold={`阈值 ${host.mem_threshold}%`} />
          <StatBox label="负载 (1m)" value={m?.load1 != null ? m.load1.toFixed(2) : (m?.flavor === "windows" ? "—" : "-")} icon={<Activity size={12} />} />
          <StatBox label="磁盘最高" value={m?.disks?.length ? `${worstDisk.toFixed(1)}%` : "-"} icon={<HardDrive size={12} />} danger={diskAlert} threshold={`阈值 ${host.disk_threshold}%`} />
          <StatBox label="下行" value={fmtBps(m?.rx_bps)} icon={<ArrowDownToLine size={12} />} />
          <StatBox label="上行" value={fmtBps(m?.tx_bps)} icon={<ArrowUpFromLine size={12} />} />
        </div>
      </div>

      {/* 区间选择 */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">时间范围：</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`btn ${range === r.key ? "btn-primary" : "btn-outline"} !h-8 !px-3 !text-xs`}
            onClick={() => selectRange(r.key)}
          >
            {r.label}
          </button>
        ))}
        {loading ? <span className="text-xs text-muted-foreground ml-2">加载中…</span> : null}
      </div>

      <div className="grid grid-cols-1 gap-3">
        <TimeSeriesChart
          title="CPU 使用率"
          series={cpuSeries}
          yMin={0} yMax={100}
          yTicks={[0, 25, 50, 75, 100]}
          yUnit="%"
        />
        <TimeSeriesChart
          title="内存使用率"
          series={memSeries}
          yMin={0} yMax={100}
          yTicks={[0, 25, 50, 75, 100]}
          yUnit="%"
        />
        <TimeSeriesChart
          title="最高磁盘占用"
          series={diskSeries}
          yMin={0} yMax={100}
          yTicks={[0, 25, 50, 75, 100]}
          yUnit="%"
        />
        {m?.flavor !== "windows" ? (
          <TimeSeriesChart
            title="系统负载（1m 平均）"
            series={loadSeries}
          />
        ) : null}
      </div>

      {m?.disks?.length ? (
        <div className="card-surface p-4 mt-5">
          <div className="text-sm font-medium mb-3">当前磁盘分区</div>
          <div className="space-y-2">
            {m.disks.map((d) => {
              const bad = d.used_pct >= host.disk_threshold;
              return (
                <div key={d.mount}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate">
                      <span className="font-medium">{d.mount}</span>
                      {d.fstype ? <span className="text-muted-foreground ml-1">({d.fstype})</span> : null}
                    </span>
                    <span className={bad ? "text-amber-500" : "text-muted-foreground"}>
                      {d.used_pct.toFixed(1)}% · {fmtBytes(d.used_bytes)} / {fmtBytes(d.total_bytes)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded bg-muted overflow-hidden mt-1">
                    <div className={`h-full ${bad ? "bg-amber-500" : "bg-emerald-500/70"}`} style={{ width: `${Math.min(100, d.used_pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {!authed ? (
        <p className="text-xs text-muted-foreground mt-6">登录后可编辑/删除主机配置。</p>
      ) : null}
    </>
  );
}

function StatBox({ label, value, icon, danger, threshold }: {
  label: string; value: string; icon: React.ReactNode; danger?: boolean; threshold?: string;
}) {
  return (
    <div className={`rounded-md border p-3 ${danger ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/40"}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
        {icon}{label}
      </div>
      <div className={`text-2xl font-semibold leading-tight mt-0.5 ${danger ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</div>
      {threshold ? <div className="text-[10px] text-muted-foreground mt-0.5">{threshold}</div> : null}
    </div>
  );
}

function fmtBytes(n?: number): string {
  if (!n || !Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtBps(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
