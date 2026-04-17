import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, setSettings, DEFAULT_SETTINGS } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { encryptOrNull } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1).max(50),
  sort_order: z.number().int().optional(),
});

const svcSchema = z.object({
  id: z.number().int().optional(),
  category_id: z.number().int().nullable().optional(),
  name: z.string().min(1).max(100),
  url: z.string().url().max(500),
  icon: z.string().max(50).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  internal_url: z.string().max(500).nullable().optional(),
  credentials: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  is_private: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  check_type: z.enum(["http", "tcp", "none"]).optional(),
  check_target: z.string().max(200).nullable().optional(),
  alerts_enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  sort_order: z.number().int().optional(),
});

const hostSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1).max(80),
  exporter_url: z.string().url().max(500),
  exporter_type: z.enum(["auto", "node", "windows"]).optional(),
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  is_private: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  alerts_enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  cpu_threshold: z.number().int().min(1).max(100).optional(),
  mem_threshold: z.number().int().min(1).max(100).optional(),
  disk_threshold: z.number().int().min(1).max(100).optional(),
  description: z.string().max(300).nullable().optional(),
  auth_header: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().optional(),
});

const schema = z.object({
  kind: z.literal("server-hub-backup").optional(),
  version: z.number().optional(),
  mode: z.enum(["replace", "merge"]).default("replace"),
  settings: z.record(z.string()).optional(),
  categories: z.array(catSchema).default([]),
  services: z.array(svcSchema).default([]),
  hosts: z.array(hostSchema).default([]),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid backup payload", detail: parsed.error.message }, { status: 400 });
  }
  const { mode, settings, categories, services, hosts } = parsed.data;

  const db = getDb();
  const tx = db.transaction(() => {
    if (mode === "replace") {
      db.exec("DELETE FROM services; DELETE FROM categories; DELETE FROM hosts;");
    }

    // 分类：以导入数据里的 id 为准（如果 replace 模式）；merge 模式下以 name 合并
    const catIdMap = new Map<number, number>();
    const insertCat = db.prepare("INSERT INTO categories (name, sort_order) VALUES (?, ?)");
    const findCatByName = db.prepare("SELECT id FROM categories WHERE name = ?");
    categories.forEach((c, i) => {
      const order = typeof c.sort_order === "number" ? c.sort_order : i;
      if (mode === "merge") {
        const exist = findCatByName.get(c.name) as { id: number } | undefined;
        if (exist) {
          if (typeof c.id === "number") catIdMap.set(c.id, exist.id);
          return;
        }
      }
      const info = insertCat.run(c.name, order);
      if (typeof c.id === "number") catIdMap.set(c.id, Number(info.lastInsertRowid));
    });

    const insertSvc = db.prepare(`
      INSERT INTO services
        (category_id, name, url, icon, description, internal_url, credentials, notes,
         is_private, check_type, check_target, alerts_enabled, sort_order, updated_at)
      VALUES
        (@category_id, @name, @url, @icon, @description, @internal_url, @credentials, @notes,
         @is_private, @check_type, @check_target, @alerts_enabled, @sort_order, datetime('now'))
    `);
    services.forEach((s, i) => {
      const cid = typeof s.category_id === "number"
        ? (catIdMap.get(s.category_id) ?? null)
        : null;
      insertSvc.run({
        category_id: cid,
        name: s.name,
        url: s.url,
        icon: s.icon ?? null,
        description: s.description ?? null,
        internal_url: s.internal_url ?? null,
        credentials: encryptOrNull(s.credentials ?? null),
        notes: s.notes ?? null,
        is_private: s.is_private === true || s.is_private === 1 ? 1 : 0,
        check_type: s.check_type ?? "http",
        check_target: s.check_target ?? null,
        alerts_enabled: s.alerts_enabled === false || s.alerts_enabled === 0 ? 0 : 1,
        sort_order: typeof s.sort_order === "number" ? s.sort_order : i,
      });
    });

    // 主机：replace 模式直接插；merge 模式按 name 合并，已存在则更新
    const insertHost = db.prepare(`
      INSERT INTO hosts
        (name, exporter_url, exporter_type, enabled, is_private, alerts_enabled,
         cpu_threshold, mem_threshold, disk_threshold, description, auth_header, sort_order, updated_at)
      VALUES
        (@name, @exporter_url, @exporter_type, @enabled, @is_private, @alerts_enabled,
         @cpu_threshold, @mem_threshold, @disk_threshold, @description, @auth_header, @sort_order, datetime('now'))
    `);
    const findHostByName = db.prepare("SELECT id FROM hosts WHERE name = ?");
    const updateHost = db.prepare(`
      UPDATE hosts SET
        exporter_url = @exporter_url, exporter_type = @exporter_type,
        enabled = @enabled, is_private = @is_private, alerts_enabled = @alerts_enabled,
        cpu_threshold = @cpu_threshold, mem_threshold = @mem_threshold, disk_threshold = @disk_threshold,
        description = @description, auth_header = @auth_header, sort_order = @sort_order,
        updated_at = datetime('now')
      WHERE id = @id
    `);
    hosts.forEach((h, i) => {
      const row = {
        name: h.name,
        exporter_url: h.exporter_url,
        exporter_type: h.exporter_type ?? "auto",
        enabled: h.enabled === false || h.enabled === 0 ? 0 : 1,
        is_private: h.is_private === true || h.is_private === 1 ? 1 : 0,
        alerts_enabled: h.alerts_enabled === false || h.alerts_enabled === 0 ? 0 : 1,
        cpu_threshold: h.cpu_threshold ?? 90,
        mem_threshold: h.mem_threshold ?? 90,
        disk_threshold: h.disk_threshold ?? 90,
        description: h.description ?? null,
        auth_header: h.auth_header ?? null,
        sort_order: typeof h.sort_order === "number" ? h.sort_order : i,
      };
      if (mode === "merge") {
        const exist = findHostByName.get(h.name) as { id: number } | undefined;
        if (exist) { updateHost.run({ ...row, id: exist.id }); return; }
      }
      insertHost.run(row);
    });

    if (settings) {
      const clean: Record<string, string> = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const v = settings[k];
        if (typeof v === "string") clean[k] = v;
      }
      setSettings(db, clean);
    }
  });
  try {
    tx();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    imported: { categories: categories.length, services: services.length, hosts: hosts.length, settings: !!settings },
    mode,
  });
}
