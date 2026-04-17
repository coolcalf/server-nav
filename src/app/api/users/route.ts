import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: number; username: string; role: string;
  must_change_password: number; created_at: string;
};

export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, username, role, must_change_password, created_at FROM users ORDER BY id"
  ).all() as Row[];
  return NextResponse.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role === "viewer" ? "viewer" : "admin",
      must_change_password: !!r.must_change_password,
      created_at: r.created_at,
    })),
  });
}

const createSchema = z.object({
  username: z.string().min(2).max(40).regex(/^[A-Za-z0-9_.-]+$/, "仅允许字母、数字、下划线、点、中横线"),
  password: z.string().min(6).max(200),
  role: z.enum(["admin", "viewer"]).default("viewer"),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
  const db = getDb();
  const exist = db.prepare("SELECT id FROM users WHERE username = ?").get(parsed.data.username);
  if (exist) return NextResponse.json({ error: "用户名已存在" }, { status: 409 });
  const hash = bcrypt.hashSync(parsed.data.password, 10);
  const info = db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)"
  ).run(parsed.data.username, hash, parsed.data.role);
  return NextResponse.json({
    user: {
      id: Number(info.lastInsertRowid),
      username: parsed.data.username,
      role: parsed.data.role,
      must_change_password: false,
    },
  });
}
