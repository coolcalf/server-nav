import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all();
  return NextResponse.json({ categories: rows });
}

const schema = z.object({ name: z.string().min(1).max(50) });

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const db = getDb();
  const maxOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories").get() as { m: number }).m;
  const info = db.prepare("INSERT INTO categories (name, sort_order) VALUES (?, ?)").run(parsed.data.name, maxOrder + 1);
  const created = db.prepare("SELECT * FROM categories WHERE id = ?").get(Number(info.lastInsertRowid));
  return NextResponse.json({ category: created });
}
