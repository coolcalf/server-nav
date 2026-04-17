import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const itemSchema = z.object({
  name: z.string().max(100).optional(),
  url: z.string().url().max(500),
  category_name: z.string().max(50).optional(),
  description: z.string().max(500).optional(),
  check_type: z.enum(["http", "tcp", "none"]).optional(),
});

const schema = z.object({
  items: z.array(itemSchema).min(1).max(500),
  default_category_name: z.string().max(50).optional(),
});

function nameFromUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return u.slice(0, 60);
  }
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const db = getDb();
  const { items, default_category_name } = parsed.data;

  const findCatByName = db.prepare("SELECT id FROM categories WHERE name = ?");
  const insertCat = db.prepare("INSERT INTO categories (name, sort_order) VALUES (?, COALESCE((SELECT MAX(sort_order)+1 FROM categories), 0))");
  function resolveCat(name?: string): number | null {
    if (!name) return null;
    const r = findCatByName.get(name) as { id: number } | undefined;
    if (r) return r.id;
    const info = insertCat.run(name);
    return Number(info.lastInsertRowid);
  }

  const insertSvc = db.prepare(`
    INSERT INTO services
      (category_id, name, url, icon, description,
       is_private, check_type, check_target, alerts_enabled, sort_order, updated_at)
    VALUES
      (@category_id, @name, @url, @icon, @description,
       0, @check_type, NULL, 1, @sort_order, datetime('now'))
  `);

  let created = 0;
  const createdCats = new Set<number>();
  const tx = db.transaction(() => {
    for (const it of items) {
      const cid = resolveCat(it.category_name || default_category_name);
      if (cid != null) createdCats.add(cid);
      const maxOrder = (db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM services WHERE IFNULL(category_id, 0) = IFNULL(?, 0)"
      ).get(cid) as { m: number }).m;

      insertSvc.run({
        category_id: cid,
        name: (it.name && it.name.trim()) || nameFromUrl(it.url),
        url: it.url,
        icon: "Globe",
        description: it.description ?? null,
        check_type: it.check_type ?? "http",
        sort_order: maxOrder + 1,
      });
      created++;
    }
  });
  try {
    tx();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, created });
}
