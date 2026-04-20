import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { isMaster, removeSnapshot } from "@/lib/federation";
import type { AgentRow } from "@/lib/federation";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/federation/agents — 列出所有已注册 agent */
export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ agents: [], mode: "not-master" });
  }

  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, enabled, public_visible, last_seen_at, sort_order, created_at FROM agents ORDER BY sort_order, created_at")
    .all() as Omit<AgentRow, "key_hash">[];

  return NextResponse.json({ agents: rows });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
});

/** POST /api/federation/agents — 注册新 agent，返回生成的密钥（仅显示一次） */
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const plainKey = `sn_${crypto.randomBytes(24).toString("base64url")}`;
  const keyHash = bcrypt.hashSync(plainKey, 10);

  const db = getDb();
  const max = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM agents").get() as { m: number }).m;

  db.prepare(
    "INSERT INTO agents (id, name, key_hash, enabled, sort_order) VALUES (?, ?, ?, 1, ?)"
  ).run(id, parsed.data.name, keyHash, max + 1);

  return NextResponse.json({
    agent: { id, name: parsed.data.name },
    key: plainKey,
    warning: "请立即保存此密钥，关闭后无法再次查看。",
  });
}

const patchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  public_visible: z.boolean().optional(),
});

/** PATCH /api/federation/agents — 更新 agent */
export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const db = getDb();
  const { id, name, enabled } = parsed.data;

  if (name !== undefined) {
    db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(name, id);
  }
  if (enabled !== undefined) {
    db.prepare("UPDATE agents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    if (!enabled) removeSnapshot(id);
  }
  if (parsed.data.public_visible !== undefined) {
    db.prepare("UPDATE agents SET public_visible = ? WHERE id = ?").run(parsed.data.public_visible ? 1 : 0, id);
  }

  const row = db.prepare("SELECT id, name, enabled, public_visible, last_seen_at, sort_order, created_at FROM agents WHERE id = ?").get(id);
  return NextResponse.json({ agent: row });
}

/** DELETE /api/federation/agents — 删除 agent */
export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  const db = getDb();
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  removeSnapshot(id);

  return NextResponse.json({ ok: true });
}
