import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readSession } from "@/lib/auth";
import { queryHostHistory, type HistoryRange } from "@/lib/host-monitor";
import type { Host } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: HistoryRange[] = ["1h", "6h", "24h", "7d"];

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const db = getDb();
  const host = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as Host | undefined;
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 私有主机需要登录
  if (host.is_private) {
    const s = await readSession();
    if (!s) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rangeRaw = (url.searchParams.get("range") || "1h") as HistoryRange;
  const range: HistoryRange = VALID.includes(rangeRaw) ? rangeRaw : "1h";
  const points = queryHostHistory(id, range);

  return NextResponse.json({ range, points, host });
}
