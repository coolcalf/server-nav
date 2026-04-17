import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { readSession, requireAdmin } from "@/lib/auth";
import type { Host } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const session = await readSession();
  const rows = db.prepare("SELECT * FROM hosts ORDER BY sort_order, id").all() as Host[];
  const filtered = session ? rows : rows.filter((h) => !h.is_private);
  // 未登录时隐藏 auth_header（敏感字段）
  const visible = session ? filtered : filtered.map((h) => ({ ...h, auth_header: null }));
  return NextResponse.json({ hosts: visible, authed: !!session });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  exporter_url: z.string().url().max(500),
  exporter_type: z.enum(["auto", "node", "windows"]).optional(),
  enabled: z.boolean().optional(),
  is_private: z.boolean().optional(),
  alerts_enabled: z.boolean().optional(),
  cpu_threshold: z.number().int().min(1).max(100).optional(),
  mem_threshold: z.number().int().min(1).max(100).optional(),
  disk_threshold: z.number().int().min(1).max(100).optional(),
  description: z.string().max(300).nullable().optional(),
  auth_header: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const db = getDb();
  const max = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM hosts").get() as { m: number }).m;
  const info = db.prepare(`
    INSERT INTO hosts (name, exporter_url, exporter_type, enabled, is_private, alerts_enabled,
                       cpu_threshold, mem_threshold, disk_threshold, description, auth_header, sort_order, updated_at)
    VALUES (@name, @exporter_url, @exporter_type, @enabled, @is_private, @alerts_enabled,
            @cpu_threshold, @mem_threshold, @disk_threshold, @description, @auth_header, @sort_order, datetime('now'))
  `).run({
    name: parsed.data.name,
    exporter_url: parsed.data.exporter_url,
    exporter_type: parsed.data.exporter_type ?? "auto",
    enabled: parsed.data.enabled === false ? 0 : 1,
    is_private: parsed.data.is_private ? 1 : 0,
    alerts_enabled: parsed.data.alerts_enabled === false ? 0 : 1,
    cpu_threshold: parsed.data.cpu_threshold ?? 90,
    mem_threshold: parsed.data.mem_threshold ?? 90,
    disk_threshold: parsed.data.disk_threshold ?? 90,
    description: parsed.data.description ?? null,
    auth_header: parsed.data.auth_header ?? null,
    sort_order: max + 1,
  });
  const created = db.prepare("SELECT * FROM hosts WHERE id = ?").get(Number(info.lastInsertRowid));
  return NextResponse.json({ host: created });
}
