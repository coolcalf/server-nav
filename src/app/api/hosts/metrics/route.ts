import { NextResponse } from "next/server";
import { ensureHostMonitor, getAllMetrics, getAllHostHistory } from "@/lib/host-monitor";
import { isMaster, getAllSnapshots, getPublicVisibleAgentIds } from "@/lib/federation";
import { readSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureHostMonitor();
  const session = await readSession();
  const res: Record<string, unknown> = {
    metrics: getAllMetrics(),
    history: getAllHostHistory(),
  };
  if (isMaster()) {
    const publicIds = session ? null : getPublicVisibleAgentIds();
    res.remoteAgents = getAllSnapshots()
      .filter((s) => session || publicIds!.has(s.agentId))
      .map((s) => ({
        agentId: s.agentId,
        agentName: s.agentName,
        receivedAt: s.receivedAt,
        hosts: session ? s.hosts : s.hosts.filter((h) => !h.is_private),
        metrics: s.hostMetrics,
        history: s.hostHistory,
      }));
  }
  return NextResponse.json(res);
}
