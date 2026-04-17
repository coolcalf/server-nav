import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: number; at: number; source: string; kind: string;
  target_id: number | null; target_name: string | null;
  text: string; ok: number; error: string | null;
};

export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 100), 1), 500);
  const source = searchParams.get("source"); // host | service | test
  const since = Number(searchParams.get("since") || 0);

  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (source) { clauses.push("source = ?"); args.push(source); }
  if (since > 0) { clauses.push("at >= ?"); args.push(since); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = getDb()
    .prepare(`SELECT id, at, source, kind, target_id, target_name, text, ok, error
                FROM alert_events ${where}
               ORDER BY at DESC
               LIMIT ?`)
    .all(...args, limit) as Row[];

  return NextResponse.json({
    events: rows.map((r) => ({
      id: r.id,
      at: r.at,
      source: r.source,
      kind: r.kind,
      target_id: r.target_id,
      target_name: r.target_name,
      text: r.text,
      ok: !!r.ok,
      error: r.error,
    })),
  });
}

export async function DELETE() {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  getDb().prepare("DELETE FROM alert_events").run();
  return NextResponse.json({ ok: true });
}
