"use client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import {
  Plus, Pencil, Trash2, RefreshCw, ExternalLink, X, Save, Server,
  Cpu, MemoryStick, HardDrive, Activity, Lock, AlertTriangle, Beaker, LineChart,
  FolderPlus, GripVertical,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragEndEvent, DragOverEvent, DragStartEvent, DragOverlay, useDroppable,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Host, HostGroup, HostMetrics, HostHistoryPoint } from "@/lib/types";
import { Sparkline } from "./sparkline";

type MetricsMap = Record<number, HostMetrics>;
type HistoryMap = Record<number, HostHistoryPoint[]>;

export type RemoteHostAgent = {
  agentId: string;
  agentName: string;
  receivedAt: number;
  hosts: Host[];
  metrics: Record<string, HostMetrics>;
  history: Record<string, HostHistoryPoint[]>;
};

export function HostsBrowser({
  initialHosts, initialMetrics, initialHistory, authed, remoteAgents: initialRemote, initialGroups,
}: {
  initialHosts: Host[];
  initialMetrics: MetricsMap;
  initialHistory: HistoryMap;
  authed: boolean;
  remoteAgents?: RemoteHostAgent[];
  initialGroups?: HostGroup[];
}) {
  const [hosts, setHosts] = useState<Host[]>(initialHosts);
  const [metrics, setMetrics] = useState<MetricsMap>(initialMetrics ?? {});
  const [history, setHistory] = useState<HistoryMap>(initialHistory ?? {});
  const [editing, setEditing] = useState<Partial<Host> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [remote, setRemote] = useState<RemoteHostAgent[]>(initialRemote ?? []);
  const [groups, setGroups] = useState<HostGroup[]>(initialGroups ?? []);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);

  async function reloadHosts() {
    const r = await fetch("/api/hosts", { cache: "no-store" });
    const j = await r.json();
    setHosts(j.hosts ?? []);
    if (j.groups) setGroups(j.groups);
    if (j.remoteAgents) setRemote((prev) => {
      const map = new Map(prev.map((a) => [a.agentId, a]));
      for (const ra of j.remoteAgents) map.set(ra.agentId, { ...map.get(ra.agentId)!, ...ra });
      return Array.from(map.values());
    });
  }
  async function reloadMetrics() {
    const r = await fetch("/api/hosts/metrics", { cache: "no-store" });
    const j = await r.json();
    if (j?.metrics) setMetrics(j.metrics);
    if (j?.history) setHistory(j.history);
    if (j?.remoteAgents) setRemote(j.remoteAgents);
  }

  useEffect(() => {
    const t = setInterval(reloadMetrics, 30_000);
    return () => clearInterval(t);
  }, []);

  async function manualRefresh() {
    setRefreshing(true);
    try { await reloadMetrics(); } finally { setRefreshing(false); }
  }

  async function onDelete(id: number) {
    if (!confirm("确认删除该主机？历史数据会一并清空。")) return;
    const r = await fetch(`/api/hosts/${id}`, { method: "DELETE" });
    if (r.ok) { toast.success("已删除"); reloadHosts(); reloadMetrics(); }
    else toast.error("删除失败");
  }

  const summary = useMemo(() => {
    let total = hosts.length;
    let online = 0, alerting = 0;
    for (const h of hosts) {
      const m = metrics[h.id];
      if (m?.ok) online++;
      const worstDisk = m?.disks?.length ? Math.max(...m.disks.map((d) => d.used_pct)) : 0;
      if (m?.ok && (
        (m.cpu_pct != null && m.cpu_pct >= h.cpu_threshold) ||
        (m.mem_pct != null && m.mem_pct >= h.mem_threshold) ||
        worstDisk >= h.disk_threshold
      )) alerting++;
    }
    for (const agent of remote) {
      total += agent.hosts.length;
      for (const h of agent.hosts) {
        const m = agent.metrics[String(h.id)];
        if (m?.ok) online++;
        const wd = m?.disks?.length ? Math.max(...m.disks.map((d) => d.used_pct)) : 0;
        if (m?.ok && (
          (m.cpu_pct != null && m.cpu_pct >= h.cpu_threshold) ||
          (m.mem_pct != null && m.mem_pct >= h.mem_threshold) ||
          wd >= h.disk_threshold
        )) alerting++;
      }
    }
    return { total, online, alerting };
  }, [hosts, metrics, remote]);

  const groupedSections = useMemo(() => {
    const byGroup = new Map<number | "none", Host[]>();
    for (const h of hosts) {
      const k = h.group_id ?? "none";
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(h);
    }
    for (const [, list] of byGroup) list.sort((a, b) => a.sort_order - b.sort_order);
    const sections: { group: HostGroup | null; items: Host[] }[] = [];
    for (const g of groups) {
      sections.push({ group: g, items: byGroup.get(g.id) ?? [] });
    }
    const ungrouped = byGroup.get("none") ?? [];
    if (ungrouped.length > 0 || groups.length === 0) sections.push({ group: null, items: ungrouped });
    return sections;
  }, [hosts, groups]);

  /* ----- 跨分组拖拽 ----- */
  async function persistReorder(affected: Map<number | "none", Host[]>) {
    const items: { id: number; group_id: number | null; sort_order: number }[] = [];
    for (const [key, list] of affected) {
      const gid = key === "none" ? null : key;
      list.forEach((h, i) => items.push({ id: h.id, group_id: gid, sort_order: i }));
    }
    const r = await fetch("/api/hosts/reorder", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }),
    });
    if (!r.ok) { toast.error("排序保存失败"); reloadHosts(); }
  }

  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function findContainerOfId(id: string | number): number | "none" | null {
    if (typeof id === "string" && id.startsWith("hg-")) {
      const rest = id.slice(3);
      return rest === "none" ? "none" : Number(rest);
    }
    const numId = typeof id === "number" ? id : Number(id);
    const h = hosts.find((x) => x.id === numId);
    if (!h) return null;
    return h.group_id ?? "none";
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = findContainerOfId(active.id);
    const to = findContainerOfId(over.id);
    if (from == null || to == null || from === to) return;
    setHosts((prev) => {
      const host = prev.find((x) => x.id === Number(active.id));
      if (!host) return prev;
      const gid = to === "none" ? null : to;
      const others = prev.filter((x) => x.id !== host.id);
      const targetList = others.filter((x) => (x.group_id ?? "none") === to);
      const updated: Host = { ...host, group_id: gid, sort_order: targetList.length };
      return [...others, updated];
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeContainer = findContainerOfId(active.id);
    const overContainer = findContainerOfId(over.id);
    if (activeContainer == null || overContainer == null) return;

    setHosts((prev) => {
      const byGrp = new Map<number | "none", Host[]>();
      for (const h of prev) {
        const k = h.group_id ?? "none";
        if (!byGrp.has(k)) byGrp.set(k, []);
        byGrp.get(k)!.push(h);
      }
      for (const [, list] of byGrp) list.sort((a, b) => a.sort_order - b.sort_order);

      const list = byGrp.get(overContainer) ?? [];
      const oldIndex = list.findIndex((h) => h.id === Number(active.id));
      let newIndex = list.findIndex((h) => h.id === Number(over.id));
      if (newIndex < 0) newIndex = list.length - 1;
      const reordered = oldIndex >= 0 && newIndex >= 0 ? arrayMove(list, oldIndex, newIndex) : list;
      byGrp.set(overContainer, reordered);

      const nextHosts: Host[] = [];
      for (const [key, arr] of byGrp) {
        arr.forEach((h, i) => nextHosts.push({ ...h, group_id: key === "none" ? null : key, sort_order: i }));
      }

      const affected = new Map<number | "none", Host[]>();
      affected.set(overContainer, byGrp.get(overContainer) ?? []);
      if (activeContainer !== overContainer) {
        affected.set(activeContainer, byGrp.get(activeContainer) ?? []);
      }
      void persistReorder(affected);

      return nextHosts;
    });
  }

  const activeHost = activeId != null ? hosts.find((h) => h.id === activeId) ?? null : null;

  return (
    <>
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{summary.online}</span> / {summary.total} 在线
          {summary.alerting > 0 ? <> · <span className="text-amber-500">{summary.alerting} 报警中</span></> : null}
        </div>
        <div className="flex-1" />
        <button className="btn btn-ghost !w-9 !h-9 !p-0" onClick={manualRefresh} title="立即刷新">
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
        {authed ? (
          <>
            <button className="btn btn-outline" onClick={() => setGroupDialogOpen(true)}>
              <FolderPlus size={14} /> 分组
            </button>
            <button className="btn btn-primary" onClick={() => setEditing({})}>
              <Plus size={14} /> 新增主机
            </button>
          </>
        ) : null}
      </div>

      {hosts.length === 0 && remote.length === 0 ? (
        <div className="card-surface p-10 text-center text-sm text-muted-foreground">
          {authed
            ? "还没有任何主机。点右上角\"新增主机\"，填一个 node_exporter 的地址（如 http://192.168.1.10:9100/metrics）。"
            : "暂无对外可见的主机。"}
        </div>
      ) : authed ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
        >
          <div className="space-y-6">
            {groupedSections.map(({ group, items }) => (
              <HostGroupSection
                key={group ? `g-${group.id}` : "ungrouped"}
                containerId={group ? `hg-${group.id}` : "hg-none"}
                group={group}
                items={items}
                metrics={metrics}
                history={history}
                authed={authed}
                onEdit={setEditing}
                onDelete={onDelete}
                hasGroups={groups.length > 0}
                hasRemote={remote.length > 0}
              />
            ))}

            {remote.map((agent) => (
              <RemoteAgentSection key={agent.agentId} agent={agent} />
            ))}
          </div>
          <DragOverlay>
            {activeHost ? (
              <div className="card-surface p-3 flex items-center gap-3 shadow-2xl cursor-grabbing opacity-90">
                <GripVertical size={16} className="text-muted-foreground" />
                <Server size={14} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{activeHost.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{activeHost.exporter_url}</div>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="space-y-6">
          {groupedSections.map(({ group, items }) => (
            <HostGroupSection
              key={group ? `g-${group.id}` : "ungrouped"}
              containerId={group ? `hg-${group.id}` : "hg-none"}
              group={group}
              items={items}
              metrics={metrics}
              history={history}
              authed={authed}
              onEdit={setEditing}
              onDelete={onDelete}
              hasGroups={groups.length > 0}
              hasRemote={remote.length > 0}
            />
          ))}

          {remote.map((agent) => (
            <RemoteAgentSection key={agent.agentId} agent={agent} />
          ))}
        </div>
      )}

      {editing !== null ? (
        <HostDialog
          initial={editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reloadHosts(); reloadMetrics(); }}
        />
      ) : null}

      {groupDialogOpen ? (
        <HostGroupDialog
          groups={groups}
          onClose={() => setGroupDialogOpen(false)}
          onChanged={() => reloadHosts()}
        />
      ) : null}
    </>
  );
}

/* -------------------- 主机分组 Section -------------------- */

function HostGroupSection({
  containerId, group, items, metrics, history, authed, onEdit, onDelete, hasGroups, hasRemote,
}: {
  containerId: string;
  group: HostGroup | null;
  items: Host[];
  metrics: MetricsMap;
  history: HistoryMap;
  authed: boolean;
  onEdit: (h: Partial<Host>) => void;
  onDelete: (id: number) => void;
  hasGroups: boolean;
  hasRemote: boolean;
}) {
  const title = group ? group.name : (hasGroups ? "未分组" : (hasRemote ? "本地主机" : null));
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  return (
    <section>
      {title && (
        <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
          <Server size={14} /> {title}
          <span className="text-[10px]">· {items.length} 台</span>
        </h3>
      )}
      <SortableContext items={items.map((h) => h.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`grid grid-cols-1 md:grid-cols-2 gap-3 min-h-[3rem] rounded-lg transition-colors ${isOver ? "bg-muted/50 outline-dashed outline-1 outline-muted-foreground/30" : ""}`}
        >
          {items.length === 0 ? (
            <div className="col-span-2 card-surface p-6 text-center text-xs text-muted-foreground">
              {isOver ? "松手放入此分组" : "空 · 可将主机拖入此处"}
            </div>
          ) : (
            items.map((h) => (
              authed ? (
                <SortableHostCard
                  key={h.id}
                  host={h}
                  metrics={metrics[h.id]}
                  history={history[h.id]}
                  authed={authed}
                  onEdit={() => onEdit(h)}
                  onDelete={() => onDelete(h.id)}
                />
              ) : (
                <HostCard
                  key={h.id}
                  host={h}
                  metrics={metrics[h.id]}
                  history={history[h.id]}
                  authed={authed}
                  onEdit={() => onEdit(h)}
                  onDelete={() => onDelete(h.id)}
                />
              )
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

/* -------------------- 可拖拽的主机卡片 -------------------- */

function SortableHostCard(props: {
  host: Host;
  metrics?: HostMetrics;
  history?: HostHistoryPoint[];
  authed: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.host.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <HostCard {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

/* -------------------- 远程 Agent 分组 -------------------- */

function RemoteAgentSection({ agent }: { agent: RemoteHostAgent }) {
  const stale = agent.receivedAt && (Date.now() - agent.receivedAt > 120_000);
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
        <Server size={14} />
        <span className="bg-accent/60 text-accent-foreground px-1.5 py-0.5 rounded text-xs">{agent.agentName}</span>
        <span className="text-[10px]">· {agent.hosts.length} 台</span>
        {stale && <span className="text-[10px] text-amber-500">· 数据可能过期</span>}
      </h3>
      {agent.hosts.length === 0 ? (
        <div className="card-surface p-4 text-center text-xs text-muted-foreground">该节点暂无主机数据</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {agent.hosts.map((h) => (
            <HostCard
              key={`${agent.agentId}_${h.id}`}
              host={h}
              metrics={agent.metrics[String(h.id)]}
              history={agent.history[String(h.id)]}
              authed={false}
              onEdit={() => {}}
              onDelete={() => {}}
              remote
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------- 卡片 -------------------- */

function fmtBytes(n?: number): string {
  if (!n || !Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtUptime(s?: number): string {
  if (!s || !Number.isFinite(s)) return "";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function HostCard({
  host, metrics, history, authed, onEdit, onDelete, remote, dragHandleProps,
}: {
  host: Host;
  metrics?: HostMetrics;
  history?: HostHistoryPoint[];
  authed: boolean;
  onEdit: () => void;
  onDelete: () => void;
  remote?: boolean;
  dragHandleProps?: Record<string, unknown>;
}) {
  const m = metrics;
  const ok = !!m?.ok;
  const worstDisk = m?.disks?.length ? Math.max(...m.disks.map((d) => d.used_pct)) : 0;
  const cpuAlert = ok && m.cpu_pct != null && m.cpu_pct >= host.cpu_threshold;
  const memAlert = ok && m.mem_pct != null && m.mem_pct >= host.mem_threshold;
  const diskAlert = ok && worstDisk >= host.disk_threshold;
  const anyAlert = cpuAlert || memAlert || diskAlert;

  const cpuHistory = (history ?? []).map((p) => p.cpu);
  const memHistory = (history ?? []).map((p) => p.mem);

  return (
    <div className={`card-surface p-4 transition-colors ${anyAlert ? "border-amber-500/40" : ""}`}>
      <div className="flex items-start gap-3">
        {dragHandleProps ? (
          <button className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none mt-1.5 shrink-0" {...dragHandleProps} title="拖拽排序">
            <GripVertical size={16} />
          </button>
        ) : null}
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-muted shrink-0">
          <Server size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {remote ? <span className="font-medium truncate">{host.name}</span> : <Link href={`/hosts/${host.id}`} className="font-medium truncate hover:underline">{host.name}</Link>}
            {host.is_private ? <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"><Lock size={10} />私有</span> : null}
            {!host.enabled ? <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">已停用</span> : null}
            {anyAlert ? <span className="text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"><AlertTriangle size={10} />超阈值</span> : null}
          </div>
          {host.description ? (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{host.description}</p>
          ) : null}
          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {host.exporter_url}
            {m?.flavor ? <> · {m.flavor}</> : null}
            {m?.uptime_seconds ? <> · 已运行 {fmtUptime(m.uptime_seconds)}</> : null}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`dot ${ok ? "dot-ok" : !m ? "dot-pending" : "dot-bad"}`} title={ok ? "在线" : (m?.error || "未知")} />
          {!remote && (
            <Link className="btn btn-ghost !h-8 !w-8 !p-0" href={`/hosts/${host.id}`} title="查看详情">
              <LineChart size={14} />
            </Link>
          )}
          {authed && !remote ? (
            <>
              <a className="btn btn-ghost !h-8 !w-8 !p-0" href={host.exporter_url} target="_blank" rel="noreferrer" title="打开 /metrics">
                <ExternalLink size={14} />
              </a>
              <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onEdit} title="编辑"><Pencil size={14} /></button>
              <button className="btn btn-ghost !h-8 !w-8 !p-0 hover:!text-rose-500" onClick={onDelete} title="删除"><Trash2 size={14} /></button>
            </>
          ) : null}
        </div>
      </div>

      {!ok ? (
        <div className="mt-3 text-xs text-rose-500/90 bg-rose-500/5 border border-rose-500/20 rounded p-2">
          {m?.error ? `抓取失败：${m.error}` : "等待首次抓取…"}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Metric
            icon={<Cpu size={12} />}
            label="CPU"
            value={m.cpu_pct != null ? `${m.cpu_pct.toFixed(1)}%` : "-"}
            danger={cpuAlert}
            sparkline={cpuHistory}
          />
          <Metric
            icon={<MemoryStick size={12} />}
            label="内存"
            value={m.mem_pct != null ? `${m.mem_pct.toFixed(1)}%` : "-"}
            sub={m.mem_total_bytes ? `${fmtBytes(m.mem_used_bytes)} / ${fmtBytes(m.mem_total_bytes)}` : undefined}
            danger={memAlert}
            sparkline={memHistory}
          />
          <Metric
            icon={<Activity size={12} />}
            label="负载 (1m)"
            value={m.load1 != null ? m.load1.toFixed(2) : (m.flavor === "windows" ? "—" : "-")}
          />
          <Metric
            icon={<HardDrive size={12} />}
            label="磁盘最高占用"
            value={m.disks.length ? `${worstDisk.toFixed(1)}%` : "-"}
            danger={diskAlert}
          />
          {m.disks.length ? (
            <div className="col-span-2 mt-1 space-y-1">
              {m.disks.slice(0, 4).map((d) => (
                <DiskRow key={d.mount} disk={d} threshold={host.disk_threshold} />
              ))}
              {m.disks.length > 4 ? <div className="text-[10px] text-muted-foreground">还有 {m.disks.length - 4} 个分区…</div> : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground mt-3">
        {m?.scrapedAt ? `采样时间 ${new Date(m.scrapedAt).toLocaleTimeString()}` : null}
      </div>
    </div>
  );
}

function Metric({
  icon, label, value, sub, danger, sparkline,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
  sparkline?: (number | null)[];
}) {
  return (
    <div className={`rounded-md border p-2 ${danger ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/40"}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1">
        {icon}{label}
      </div>
      <div className={`text-lg font-semibold leading-tight mt-0.5 ${danger ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
      {sparkline && sparkline.length > 1 ? (
        <span className={danger ? "text-amber-500/80" : "text-emerald-500/80"}>
          <Sparkline data={sparkline} width={120} height={20} />
        </span>
      ) : null}
    </div>
  );
}

function DiskRow({ disk, threshold }: { disk: HostMetrics["disks"][number]; threshold: number }) {
  const pct = Math.min(100, Math.max(0, disk.used_pct));
  const bad = pct >= threshold;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate">{disk.mount} {disk.fstype ? <span className="opacity-60">({disk.fstype})</span> : null}</span>
        <span className={bad ? "text-amber-500" : ""}>{pct.toFixed(1)}% · {fmtBytes(disk.used_bytes)} / {fmtBytes(disk.total_bytes)}</span>
      </div>
      <div className="h-1.5 rounded bg-muted overflow-hidden">
        <div
          className={`h-full ${bad ? "bg-amber-500" : "bg-emerald-500/70"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* -------------------- 编辑/新增对话框 -------------------- */

function HostDialog({
  initial, groups, onClose, onSaved,
}: {
  initial: Partial<Host>;
  groups: HostGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = typeof initial.id === "number";
  const [form, setForm] = useState<Partial<Host>>({
    name: "", exporter_url: "", exporter_type: "auto",
    enabled: 1, is_private: 0, alerts_enabled: 1,
    cpu_threshold: 90, mem_threshold: 90, disk_threshold: 90,
    description: "", auth_header: "", group_id: null,
    ...initial,
  });
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<HostMetrics | null>(null);

  function set<K extends keyof Host>(k: K, v: Host[K] | null | undefined) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function doProbe() {
    if (!form.exporter_url) return toast.error("请先填 exporter URL");
    setProbing(true);
    setProbe(null);
    try {
      const r = await fetch("/api/hosts/probe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exporter_url: form.exporter_url,
          exporter_type: form.exporter_type ?? "auto",
          auth_header: form.auth_header?.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "测试失败");
      setProbe(j.metrics);
      if (j.metrics?.ok) toast.success("连接成功");
      else toast.error(`抓取失败：${j.metrics?.error ?? ""}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProbing(false);
    }
  }

  async function save() {
    if (!form.name?.trim()) return toast.error("请填名称");
    if (!form.exporter_url?.trim()) return toast.error("请填 exporter URL");
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        exporter_url: form.exporter_url.trim(),
        exporter_type: form.exporter_type ?? "auto",
        enabled: !!form.enabled,
        is_private: !!form.is_private,
        alerts_enabled: !!form.alerts_enabled,
        cpu_threshold: Number(form.cpu_threshold ?? 90),
        mem_threshold: Number(form.mem_threshold ?? 90),
        disk_threshold: Number(form.disk_threshold ?? 90),
        description: form.description || null,
        auth_header: form.auth_header?.trim() || null,
        group_id: form.group_id ?? null,
      };
      const r = await fetch(isEdit ? `/api/hosts/${initial.id}` : "/api/hosts", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "保存失败");
      toast.success(isEdit ? "已更新" : "已创建");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{isEdit ? "编辑主机" : "新增主机"}</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="label">名称</label>
              <input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="家里的 NAS" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Exporter URL（/metrics 端点）</label>
              <input
                className="input"
                value={form.exporter_url ?? ""}
                onChange={(e) => set("exporter_url", e.target.value)}
                placeholder="http://192.168.1.10:9100/metrics"
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                Linux 装 <code>node_exporter</code>（默认 9100），Windows 装 <code>windows_exporter</code>（默认 9182）。
              </div>
            </div>
            <div>
              <label className="label">Exporter 类型</label>
              <select className="input" value={form.exporter_type ?? "auto"} onChange={(e) => set("exporter_type", e.target.value as Host["exporter_type"])}>
                <option value="auto">自动检测</option>
                <option value="node">node_exporter (Linux/Mac)</option>
                <option value="windows">windows_exporter</option>
              </select>
            </div>
            <div>
              <label className="label">分组</label>
              <select className="input" value={form.group_id ?? ""} onChange={(e) => set("group_id", e.target.value ? Number(e.target.value) : null)}>
                <option value="">未分组</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">描述（可选）</label>
              <input className="input" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Authorization 请求头（可选）</label>
              <input
                className="input"
                value={form.auth_header ?? ""}
                onChange={(e) => set("auth_header", e.target.value)}
                placeholder="Bearer xxx 或 Basic base64(user:pass)"
                autoComplete="off"
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                当 exporter 被反代保护需要鉴权时填写，会作为 HTTP <code>Authorization</code> 头一起带上。留空则不带。
              </div>
            </div>

            <div>
              <label className="label">CPU 阈值 %</label>
              <input className="input" type="number" min={1} max={100} value={form.cpu_threshold ?? 90} onChange={(e) => set("cpu_threshold", Number(e.target.value))} />
            </div>
            <div>
              <label className="label">内存阈值 %</label>
              <input className="input" type="number" min={1} max={100} value={form.mem_threshold ?? 90} onChange={(e) => set("mem_threshold", Number(e.target.value))} />
            </div>
            <div>
              <label className="label">磁盘阈值 %</label>
              <input className="input" type="number" min={1} max={100} value={form.disk_threshold ?? 90} onChange={(e) => set("disk_threshold", Number(e.target.value))} />
            </div>

            <div className="sm:col-span-2 flex flex-wrap gap-x-5 gap-y-2 pt-1">
              <label className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!form.enabled} onChange={(e) => set("enabled", (e.target.checked ? 1 : 0) as Host["enabled"])} />
                启用监控
              </label>
              <label className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!form.is_private} onChange={(e) => set("is_private", (e.target.checked ? 1 : 0) as Host["is_private"])} />
                仅登录可见
              </label>
              <label className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!form.alerts_enabled} onChange={(e) => set("alerts_enabled", (e.target.checked ? 1 : 0) as Host["alerts_enabled"])} />
                超阈值/掉线发 webhook
              </label>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button className="btn btn-outline" onClick={doProbe} disabled={probing || !form.exporter_url}>
              <Beaker size={14} /> {probing ? "测试中…" : "测试连接"}
            </button>
            {probe ? (
              probe.ok ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  ✔ {probe.flavor} · CPU {probe.cpu_pct ?? "-"}% · 内存 {probe.mem_pct?.toFixed(1) ?? "-"}% · 磁盘 {probe.disks.length} 个
                </span>
              ) : (
                <span className="text-xs text-rose-500">✖ {probe.error}</span>
              )
            ) : null}
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              <Save size={14} /> {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 分组管理对话框 -------------------- */

function HostGroupDialog({
  groups: initialGroups, onClose, onChanged,
}: {
  groups: HostGroup[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<HostGroup[]>(initialGroups);
  const [name, setName] = useState("");

  async function reload() {
    const r = await fetch("/api/host-groups", { cache: "no-store" });
    const j = await r.json();
    setList(j.groups ?? []);
    onChanged();
  }

  async function add() {
    if (!name.trim()) return;
    const r = await fetch("/api/host-groups", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (r.ok) { setName(""); reload(); toast.success("已添加"); }
    else toast.error("添加失败");
  }

  async function rename(g: HostGroup, newName: string) {
    if (!newName.trim() || newName === g.name) return;
    const r = await fetch(`/api/host-groups/${g.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (r.ok) reload(); else toast.error("重命名失败");
  }

  async function del(g: HostGroup) {
    if (!confirm(`确认删除分组「${g.name}」？分组内的主机将变为"未分组"。`)) return;
    const r = await fetch(`/api/host-groups/${g.id}`, { method: "DELETE" });
    if (r.ok) { reload(); toast.success("已删除"); } else toast.error("删除失败");
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-md p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">主机分组管理</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="flex gap-2 mb-4">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="新分组名称"
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <button className="btn btn-primary" onClick={add}><Plus size={14} /> 添加</button>
          </div>

          <div className="space-y-2">
            {list.map((g) => <HostGroupRow key={g.id} group={g} onRename={(n) => rename(g, n)} onDelete={() => del(g)} />)}
            {list.length === 0 ? <p className="text-xs text-muted-foreground text-center py-4">暂无分组</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}

function HostGroupRow({ group, onRename, onDelete }: { group: HostGroup; onRename: (n: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(group.name);
  return (
    <div className="flex items-center gap-2 card-surface !p-2 px-3">
      <Server size={14} className="text-muted-foreground" />
      {editing ? (
        <input className="input !h-8 flex-1" value={v} onChange={(e) => setV(e.target.value)} autoFocus
               onKeyDown={(e) => { if (e.key === "Enter") { onRename(v); setEditing(false); } }} />
      ) : (
        <span className="flex-1 truncate">{group.name}</span>
      )}
      {editing ? (
        <button className="btn btn-ghost" onClick={() => { onRename(v); setEditing(false); }}><Save size={14} /></button>
      ) : (
        <button className="btn btn-ghost" onClick={() => setEditing(true)}><Pencil size={14} /></button>
      )}
      <button className="btn btn-ghost text-destructive" onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}
