import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { createApiToken } from "@/lib/mobile-auth";
import { extractClientIp, loginRateCheck, loginRateFail, loginRateClear } from "@/lib/rate-limit";

export const runtime = "nodejs";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  device_name: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const ip = extractClientIp(req);
  const key = `mobile|${ip}|${parsed.data.username.toLowerCase()}`;
  const gate = loginRateCheck(key);
  if (!gate.allowed) {
    const retrySec = Math.ceil((gate.retryAfterMs ?? 0) / 1000);
    return NextResponse.json(
      { error: `尝试次数过多，${Math.ceil(retrySec / 60)} 分钟后再试` },
      { status: 429, headers: { "retry-after": String(retrySec) } },
    );
  }

  const db = getDb();
  const row = db.prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
    .get(parsed.data.username) as { id: number; username: string; password_hash: string; role: string } | undefined;

  const passwordOk = !!row && bcrypt.compareSync(parsed.data.password, row.password_hash);
  if (!row || !passwordOk) {
    const r = loginRateFail(key);
    if (r.locked) {
      const retrySec = Math.ceil((r.retryAfterMs ?? 0) / 1000);
      return NextResponse.json(
        { error: `尝试次数过多，已锁定 ${Math.ceil(retrySec / 60)} 分钟` },
        { status: 429, headers: { "retry-after": String(retrySec) } },
      );
    }
    return NextResponse.json({ error: `用户名或密码错误（剩余 ${r.remaining} 次）` }, { status: 401 });
  }

  loginRateClear(key);
  const role = row.role === "viewer" ? "viewer" : "admin";
  const { raw, record } = createApiToken(row.id, parsed.data.device_name || "Mobile App");

  return NextResponse.json({
    token: raw,
    token_id: record.id,
    expires_at: record.expires_at,
    user: { id: row.id, username: row.username, role },
  });
}
