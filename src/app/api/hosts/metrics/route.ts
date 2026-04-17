import { NextResponse } from "next/server";
import { ensureHostMonitor, getAllMetrics, getAllHostHistory } from "@/lib/host-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureHostMonitor();
  return NextResponse.json({
    metrics: getAllMetrics(),
    history: getAllHostHistory(),
  });
}
