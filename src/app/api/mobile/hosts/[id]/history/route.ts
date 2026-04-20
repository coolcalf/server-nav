import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireMobileAuth, getAccessibleHostIds } from "@/lib/mobile-auth";
import { queryHostHistory, type HistoryRange } from "@/lib/host-monitor";
import type { Host } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: HistoryRange[] = ["1h", "6h", "24h", "7d"];

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = requireMobileAuth(req);
  if (session instanceof Response) return session;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const db = getDb();
  const host = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as Host | undefined;
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 权限检查
  const allowed = getAccessibleHostIds(session.uid, session.role);
  if (allowed !== null && !allowed.has(id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rangeRaw = (url.searchParams.get("range") || "1h") as HistoryRange;
  const range: HistoryRange = VALID.includes(rangeRaw) ? rangeRaw : "1h";
  const points = queryHostHistory(id, range);

  return NextResponse.json({ range, points });
}
