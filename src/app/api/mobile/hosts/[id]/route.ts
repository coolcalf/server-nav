import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireMobileAuth, getAccessibleHostIds } from "@/lib/mobile-auth";
import { ensureHostMonitor, getAllMetrics } from "@/lib/host-monitor";
import type { Host } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  ensureHostMonitor();
  const metrics = getAllMetrics()[id] ?? null;

  // 隐藏敏感字段
  const { auth_header: _, exporter_url: __, ...safeHost } = host;

  return NextResponse.json({ host: safeHost, metrics });
}
