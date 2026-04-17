import { NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";
import { readSession, requireAdmin } from "@/lib/auth";
import { encryptOrNull, decryptOrNull } from "@/lib/crypto";
import { z } from "zod";
import type { Service } from "@/lib/types";

export const runtime = "nodejs";

const createSchema = z.object({
  category_id: z.number().int().nullable().optional(),
  name: z.string().min(1).max(100),
  url: z.string().url().max(500),
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

export async function GET() {
  const db = getDb();
  const session = await readSession();
  const rows = db
    .prepare(
      `SELECT s.*, c.name AS category_name FROM services s
       LEFT JOIN categories c ON c.id = s.category_id
       ORDER BY COALESCE(c.sort_order, 999999), s.sort_order, s.id`
    )
    .all() as (Service & { category_name: string | null })[];

  const categories = db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all();

  if (!session) {
    const filtered = rows
      .filter((r) => !r.is_private)
      .map(({ internal_url, credentials, notes, is_private, ...pub }) => {
        void internal_url; void credentials; void notes; void is_private;
        return pub;
      });
    return NextResponse.json({ services: filtered, categories, authed: false });
  }
  // 登录用户：把 credentials 解密回明文再返回前端
  const decoded = rows.map((r) => ({ ...r, credentials: decryptOrNull(r.credentials) }));
  return NextResponse.json({ services: decoded, categories, authed: true });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const db = getDb();
  const maxOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM services WHERE IFNULL(category_id, 0) = IFNULL(?, 0)").get(parsed.data.category_id ?? null) as { m: number }).m;
  const info = db
    .prepare(
      `INSERT INTO services (category_id, name, url, icon, description, internal_url, credentials, notes, is_private, check_type, check_target, alerts_enabled, sort_order, updated_at)
       VALUES (@category_id, @name, @url, @icon, @description, @internal_url, @credentials, @notes, @is_private, @check_type, @check_target, @alerts_enabled, @sort_order, @updated_at)`
    )
    .run({
      category_id: parsed.data.category_id ?? null,
      name: parsed.data.name,
      url: parsed.data.url,
      icon: parsed.data.icon ?? null,
      description: parsed.data.description ?? null,
      internal_url: parsed.data.internal_url ?? null,
      credentials: encryptOrNull(parsed.data.credentials ?? null),
      notes: parsed.data.notes ?? null,
      is_private: parsed.data.is_private ? 1 : 0,
      check_type: parsed.data.check_type ?? "http",
      check_target: parsed.data.check_target ?? null,
      alerts_enabled: parsed.data.alerts_enabled === false ? 0 : 1,
      sort_order: maxOrder + 1,
      updated_at: nowIso(),
    });

  const created = db.prepare("SELECT * FROM services WHERE id = ?").get(Number(info.lastInsertRowid)) as Service | undefined;
  if (created) created.credentials = decryptOrNull(created.credentials);
  return NextResponse.json({ service: created });
}
