import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireMobileAuth, filterHostsByAccess } from "@/lib/mobile-auth";
import { ensureHostMonitor, getAllMetrics, getAllHostHistory } from "@/lib/host-monitor";
import type { Host, HostGroup } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = requireMobileAuth(req);
  if (session instanceof Response) return session;

  const db = getDb();
  const allHosts = db.prepare("SELECT * FROM hosts WHERE enabled = 1 ORDER BY sort_order, id").all() as Host[];
  const hosts = filterHostsByAccess(allHosts, session.uid, session.role);
  const groups = db.prepare("SELECT * FROM host_groups ORDER BY sort_order, id").all() as HostGroup[];

  ensureHostMonitor();
  const allMetrics = getAllMetrics();
  const allHistory = getAllHostHistory();

  // 只返回用户有权限看到的主机的指标
  const hostIds = new Set(hosts.map((h) => h.id));
  const metrics: Record<number, unknown> = {};
  const history: Record<number, unknown> = {};
  for (const id of hostIds) {
    if (allMetrics[id]) metrics[id] = allMetrics[id];
    if (allHistory[id]) history[id] = allHistory[id];
  }

  // 过滤分组：只返回包含可见主机的分组
  const usedGroupIds = new Set(hosts.map((h) => h.group_id).filter(Boolean));
  const visibleGroups = groups.filter((g) => usedGroupIds.has(g.id));

  // 隐藏敏感字段
  const safeHosts = hosts.map(({ auth_header: _, exporter_url: __, ...rest }) => rest);

  return NextResponse.json({
    hosts: safeHosts,
    groups: visibleGroups,
    metrics,
    history,
  });
}
