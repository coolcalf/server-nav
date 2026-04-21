import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireMobileAuth, filterHostsByAccess, getAccessibleAgentGrants } from "@/lib/mobile-auth";
import { ensureHostMonitor, getAllMetrics, getAllHostHistory } from "@/lib/host-monitor";
import { isMaster, getAllSnapshots } from "@/lib/federation";
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

  // 联邦主控模式：附加远程 agent 主机
  const remoteAgents: { agentId: string; agentName: string; hosts: unknown[]; metrics: Record<string, unknown>; history: Record<string, unknown> }[] = [];
  if (isMaster()) {
    const grants = getAccessibleAgentGrants(session.uid, session.role);
    const snapshots = getAllSnapshots();
    for (const s of snapshots) {
      if (grants === null) {
        // admin 可见全部
        remoteAgents.push({
          agentId: s.agentId,
          agentName: s.agentName,
          hosts: s.hosts.map(({ auth_header: _, exporter_url: __, ...rest }) => rest),
          metrics: s.hostMetrics,
          history: s.hostHistory,
        });
      } else {
        // 整个节点授权
        if (grants.fullAgents.has(s.agentId)) {
          remoteAgents.push({
            agentId: s.agentId,
            agentName: s.agentName,
            hosts: s.hosts.map(({ auth_header: _, exporter_url: __, ...rest }) => rest),
            metrics: s.hostMetrics,
            history: s.hostHistory,
          });
        } else {
          // 按远程主机精确授权
          const allowed = grants.hostGrants.get(s.agentId);
          if (allowed && allowed.size > 0) {
            const filteredHosts = s.hosts.filter((h) => allowed.has(h.id));
            if (filteredHosts.length > 0) {
              const filteredMetrics: Record<string, unknown> = {};
              const filteredHistory: Record<string, unknown> = {};
              for (const h of filteredHosts) {
                if (s.hostMetrics[h.id]) filteredMetrics[h.id] = s.hostMetrics[h.id];
                if (s.hostHistory[h.id]) filteredHistory[h.id] = s.hostHistory[h.id];
              }
              remoteAgents.push({
                agentId: s.agentId,
                agentName: s.agentName,
                hosts: filteredHosts.map(({ auth_header: _, exporter_url: __, ...rest }) => rest),
                metrics: filteredMetrics,
                history: filteredHistory,
              });
            }
          }
        }
      }
    }
  }

  return NextResponse.json({
    hosts: safeHosts,
    groups: visibleGroups,
    metrics,
    history,
    ...(remoteAgents.length > 0 ? { remoteAgents } : {}),
  });
}
