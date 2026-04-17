import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  items: z.array(z.object({
    id: z.number().int(),
    category_id: z.number().int().nullable(),
    sort_order: z.number().int(),
  })),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const db = getDb();
  const stmt = db.prepare("UPDATE services SET category_id = ?, sort_order = ? WHERE id = ?");
  const tx = db.transaction((items: typeof parsed.data.items) => {
    for (const it of items) stmt.run(it.category_id, it.sort_order, it.id);
  });
  tx(parsed.data.items);
  return NextResponse.json({ ok: true });
}
