import { NextResponse } from "next/server";
import { getAllStatuses, getAllHistory, getLastRunAt, ensureHealthMonitor } from "@/lib/health-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureHealthMonitor();
  return NextResponse.json({
    statuses: getAllStatuses(),
    history: getAllHistory(),
    lastRunAt: getLastRunAt(),
  });
}
