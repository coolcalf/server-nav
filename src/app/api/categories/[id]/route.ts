import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(50).optional(),
  sort_order: z.number().int().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const db = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id: Number(params.id) };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields.push(`${k} = @${k}`);
    values[k] = v;
  }
  if (fields.length) db.prepare(`UPDATE categories SET ${fields.join(", ")} WHERE id = @id`).run(values);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const db = getDb();
  db.prepare("DELETE FROM categories WHERE id = ?").run(Number(params.id));
  return NextResponse.json({ ok: true });
}
