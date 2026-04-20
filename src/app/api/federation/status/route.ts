import { NextResponse } from "next/server";
import { getFederationMode, isMaster, isAgent, getAllSnapshots, getAgentStatus } from "@/lib/federation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/federation/status — 返回当前实例的联邦状态 */
export async function GET() {
  const mode = getFederationMode();

  if (isAgent()) {
    return NextResponse.json(getAgentStatus());
  }

  if (isMaster()) {
    const snapshots = getAllSnapshots();
    return NextResponse.json({
      mode: "master",
      agents: snapshots.map((s) => ({
        id: s.agentId,
        name: s.agentName,
        receivedAt: s.receivedAt,
        hostCount: s.hosts.length,
        serviceCount: s.services.length,
      })),
    });
  }

  return NextResponse.json({ mode });
}
