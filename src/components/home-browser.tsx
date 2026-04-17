"use client";
import { useEffect, useMemo, useState } from "react";
import { Search, X, RefreshCw } from "lucide-react";
import { ServiceCard, type CardStatus } from "./service-card";
import type { Service, Category } from "@/lib/types";

type Statuses = Record<number, NonNullable<CardStatus>>;
type Histories = Record<number, (number | null)[]>;

export function HomeBrowser({
  services,
  categories,
  authed,
  initialStatuses,
  initialHistory,
}: {
  services: Service[];
  categories: Category[];
  authed: boolean;
  initialStatuses: Statuses;
  initialHistory: Histories;
}) {
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState<Statuses>(initialStatuses ?? {});
  const [history, setHistory] = useState<Histories>(initialHistory ?? {});
  const [refreshing, setRefreshing] = useState(false);

  // 定期刷新状态（30s）
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/health/statuses", { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (j?.statuses) setStatuses(j.statuses);
        if (j?.history) setHistory(j.history);
      } catch { /* ignore */ }
    };
    const timer = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  async function manualRefresh() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/health/statuses", { cache: "no-store" });
      const j = await r.json();
      if (j?.statuses) setStatuses(j.statuses);
      if (j?.history) setHistory(j.history);
    } finally {
      setRefreshing(false);
    }
  }

  // 搜索过滤
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return services;
    return services.filter((s) => {
      const hay = [
        s.name, s.url, s.description ?? "",
        authed ? s.internal_url ?? "" : "",
        authed ? s.notes ?? "" : "",
        s.check_target ?? "",
      ].join(" \u0001 ").toLowerCase();
      return hay.includes(needle);
    });
  }, [services, needle, authed]);

  // 分组
  const grouped = useMemo(() => {
    const g = new Map<number | "none", Service[]>();
    for (const s of filtered) {
      const k = s.category_id ?? "none";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(s);
    }
    return g;
  }, [filtered]);

  const total = services.length;
  const shown = filtered.length;
  const onlineCount = filtered.reduce((n, s) => {
    const st = statuses[s.id];
    if ((s.check_type ?? "http") === "none") return n;
    if (st?.ok) return n + 1;
    return n;
  }, 0);

  // 统计全部服务（不受搜索影响）中的离线数量，同步到 tab 标题
  const offlineTotal = services.reduce((n, s) => {
    if ((s.check_type ?? "http") === "none") return n;
    const st = statuses[s.id];
    if (st && !st.ok) return n + 1;
    return n;
  }, 0);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = document.title.replace(/^\(🔴\s*\d+\)\s*/, "");
    document.title = offlineTotal > 0 ? `(🔴 ${offlineTotal}) ${base}` : base;
  }, [offlineTotal]);

  return (
    <>
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xl">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            className="input pl-8 pr-8"
            placeholder="搜索服务：名称 / 描述 / URL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q ? (
            <button
              aria-label="清除"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setQ("")}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        <button className="btn btn-ghost" onClick={manualRefresh} disabled={refreshing} title="刷新状态">
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
        <div className="text-xs text-muted-foreground ml-auto">
          {needle ? <>{shown} / {total} 项 · </> : <>{total} 项 · </>}
          在线 {onlineCount}
        </div>
      </div>

      <div className="space-y-10">
        {categories.map((cat) => {
          const list = grouped.get(cat.id) ?? [];
          if (list.length === 0) return null;
          return (
            <Group key={cat.id} title={cat.name} count={list.length}>
              {list.map((s) => (
                <ServiceCard key={s.id} service={s} authed={authed} status={statuses?.[s.id] ?? null} history={history?.[s.id]} />
              ))}
            </Group>
          );
        })}
        {(() => {
          const list = grouped.get("none") ?? [];
          if (list.length === 0) return null;
          return (
            <Group title="未分类" count={list.length}>
              {list.map((s) => (
                <ServiceCard key={s.id} service={s} authed={authed} status={statuses?.[s.id] ?? null} history={history?.[s.id]} />
              ))}
            </Group>
          );
        })()}
        {filtered.length === 0 ? (
          <div className="card-surface p-10 text-center text-sm text-muted-foreground">
            {needle ? `没有匹配 “${q}” 的服务` : "还没有任何服务，去 /admin 添加第一条吧。"}
          </div>
        ) : null}
      </div>
    </>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}
