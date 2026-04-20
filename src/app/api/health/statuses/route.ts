import { NextResponse } from "next/server";
import { getAllStatuses, getAllHistory, getLastRunAt, ensureHealthMonitor } from "@/lib/health-monitor";
import { isMaster, getAllSnapshots, getPublicVisibleAgentIds } from "@/lib/federation";
import { readSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureHealthMonitor();
  const session = await readSession();
  const res: Record<string, unknown> = {
    statuses: getAllStatuses(),
    history: getAllHistory(),
    lastRunAt: getLastRunAt(),
  };
  if (isMaster()) {
    const publicIds = session ? null : getPublicVisibleAgentIds();
    res.remoteAgents = getAllSnapshots()
      .filter((s) => session || publicIds!.has(s.agentId))
      .map((s) => ({
        agentId: s.agentId,
        agentName: s.agentName,
        receivedAt: s.receivedAt,
        services: s.services,
        categories: s.categories,
        statuses: s.serviceStatuses,
        history: s.serviceHistory,
      }));
  }
  return NextResponse.json(res);
}
