import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

const schema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: z.string().min(6).max(200),
});

export async function POST(req: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "新密码至少 6 位" }, { status: 400 });

  const db = getDb();
  const row = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(session.sub) as
    | { id: number; password_hash: string } | undefined;
  if (!row) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  const ok = await bcrypt.compare(parsed.data.oldPassword, row.password_hash);
  if (!ok) return NextResponse.json({ error: "当前密码不正确" }, { status: 400 });

  if (parsed.data.oldPassword === parsed.data.newPassword) {
    return NextResponse.json({ error: "新密码不能与当前密码相同" }, { status: 400 });
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(newHash, row.id);

  return NextResponse.json({ ok: true });
}
