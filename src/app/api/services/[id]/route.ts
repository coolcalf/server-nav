import { NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { encryptOrNull, decryptOrNull } from "@/lib/crypto";
import { z } from "zod";
import type { Service } from "@/lib/types";

export const runtime = "nodejs";

const updateSchema = z.object({
  category_id: z.number().int().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().max(500).optional(),
  icon: z.string().max(50).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  internal_url: z.string().max(500).nullable().optional(),
  credentials: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  is_private: z.boolean().optional(),
  check_type: z.enum(["http", "tcp", "none"]).optional(),
  check_target: z.string().max(200).nullable().optional(),
  alerts_enabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  const id = Number(params.id);
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const db = getDb();
  const existing = db.prepare("SELECT * FROM services WHERE id = ?").get(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fields: string[] = [];
  const values: Record<string, unknown> = { id, updated_at: nowIso() };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields.push(`${k} = @${k}`);
    if (k === "is_private" || k === "alerts_enabled") values[k] = v ? 1 : 0;
    else if (k === "credentials") values[k] = encryptOrNull(v as string | null);
    else values[k] = v;
  }
  fields.push("updated_at = @updated_at");
  db.prepare(`UPDATE services SET ${fields.join(", ")} WHERE id = @id`).run(values);

  const updated = db.prepare("SELECT * FROM services WHERE id = ?").get(id) as Service | undefined;
  if (updated) updated.credentials = decryptOrNull(updated.credentials);
  return NextResponse.json({ service: updated });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const db = getDb();
  db.prepare("DELETE FROM services WHERE id = ?").run(Number(params.id));
  return NextResponse.json({ ok: true });
}
