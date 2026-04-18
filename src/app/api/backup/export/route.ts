import { NextResponse } from "next/server";
import { getDb, getSettings } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { decryptOrNull } from "@/lib/crypto";
import type { Service, Category, Host } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const db = getDb();

  const categories = db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all() as Category[];
  const services = db.prepare("SELECT * FROM services ORDER BY sort_order, id").all() as Service[];
  const hosts = db.prepare("SELECT * FROM hosts ORDER BY sort_order, id").all() as Host[];
  const settings = getSettings(db);

  const payload = {
    kind: "server-nav-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    categories: categories.map(({ id, name, sort_order }) => ({ id, name, sort_order })),
    services: services.map((s) => ({
      id: s.id,
      category_id: s.category_id,
      name: s.name,
      url: s.url,
      icon: s.icon,
      description: s.description,
      internal_url: s.internal_url,
      credentials: decryptOrNull(s.credentials),
      notes: s.notes,
      is_private: s.is_private,
      check_type: s.check_type ?? "http",
      check_target: s.check_target ?? null,
      alerts_enabled: s.alerts_enabled ?? 1,
      sort_order: s.sort_order,
    })),
    hosts: hosts.map((h) => ({
      id: h.id,
      name: h.name,
      exporter_url: h.exporter_url,
      exporter_type: h.exporter_type,
      enabled: h.enabled,
      is_private: h.is_private,
      alerts_enabled: h.alerts_enabled,
      cpu_threshold: h.cpu_threshold,
      mem_threshold: h.mem_threshold,
      disk_threshold: h.disk_threshold,
      description: h.description,
      auth_header: h.auth_header ?? null,
      sort_order: h.sort_order,
    })),
  };

  const filename = `server-nav-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
