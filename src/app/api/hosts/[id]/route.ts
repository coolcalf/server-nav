import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  exporter_url: z.string().url().max(500).optional(),
  exporter_type: z.enum(["auto", "node", "windows"]).optional(),
  enabled: z.boolean().optional(),
  is_private: z.boolean().optional(),
  alerts_enabled: z.boolean().optional(),
  cpu_threshold: z.number().int().min(1).max(100).optional(),
  mem_threshold: z.number().int().min(1).max(100).optional(),
  disk_threshold: z.number().int().min(1).max(100).optional(),
  description: z.string().max(300).nullable().optional(),
  auth_header: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().optional(),
});

const BOOL_FIELDS = new Set(["enabled", "is_private", "alerts_enabled"]);

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const id = Number(params.id);
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const db = getDb();
  const exists = db.prepare("SELECT id FROM hosts WHERE id = ?").get(id);
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fields: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields.push(`${k} = @${k}`);
    values[k] = BOOL_FIELDS.has(k) ? (v ? 1 : 0) : v;
  }
  fields.push("updated_at = datetime('now')");
  db.prepare(`UPDATE hosts SET ${fields.join(", ")} WHERE id = @id`).run(values);
  const updated = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
  return NextResponse.json({ host: updated });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const db = getDb();
  db.prepare("DELETE FROM hosts WHERE id = ?").run(Number(params.id));
  return NextResponse.json({ ok: true });
}
