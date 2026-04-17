import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  role: z.enum(["admin", "viewer"]).optional(),
  password: z.string().min(6).max(200).optional(),
});

type Row = { id: number; username: string; role: string };

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const id = Number(params.id);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, { status: 400 });

  const db = getDb();
  const target = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id) as Row | undefined;
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  // 防止把"最后一个 admin"降级为 viewer
  if (parsed.data.role === "viewer" && target.role === "admin") {
    const adminCount = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as { c: number }).c;
    if (adminCount <= 1) {
      return NextResponse.json({ error: "至少保留一个管理员" }, { status: 400 });
    }
  }

  const fields: string[] = [];
  const values: Record<string, unknown> = { id };
  if (parsed.data.role) {
    fields.push("role = @role");
    values.role = parsed.data.role;
  }
  if (parsed.data.password) {
    fields.push("password_hash = @password_hash");
    values.password_hash = bcrypt.hashSync(parsed.data.password, 10);
    fields.push("must_change_password = 0");
  }
  if (fields.length === 0) return NextResponse.json({ ok: true });
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = @id`).run(values);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const id = Number(params.id);

  const db = getDb();
  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as
    | { id: number; role: string } | undefined;
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  // 不能删除自己
  if (gate.uid === id) {
    return NextResponse.json({ error: "不能删除当前登录的账号" }, { status: 400 });
  }
  // 不能删除最后一个管理员
  if (target.role === "admin") {
    const adminCount = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as { c: number }).c;
    if (adminCount <= 1) {
      return NextResponse.json({ error: "至少保留一个管理员" }, { status: 400 });
    }
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
