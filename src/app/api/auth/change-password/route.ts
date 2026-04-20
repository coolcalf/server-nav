import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { extractClientIp, loginRateCheck, loginRateFail, loginRateClear } from "@/lib/rate-limit";

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

  const ip = extractClientIp(req);
  const key = `chpwd|${ip}|${session.sub}`;
  const gate = loginRateCheck(key);
  if (!gate.allowed) {
    const retrySec = Math.ceil((gate.retryAfterMs ?? 0) / 1000);
    return NextResponse.json(
      { error: `尝试次数过多，${Math.ceil(retrySec / 60)} 分钟后再试` },
      { status: 429, headers: { "retry-after": String(retrySec) } },
    );
  }

  const db = getDb();
  const row = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(session.sub) as
    | { id: number; password_hash: string } | undefined;
  if (!row) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  const ok = await bcrypt.compare(parsed.data.oldPassword, row.password_hash);
  if (!ok) {
    const r = loginRateFail(key);
    if (r.locked) {
      const retrySec = Math.ceil((r.retryAfterMs ?? 0) / 1000);
      return NextResponse.json(
        { error: `尝试次数过多，已锁定 ${Math.ceil(retrySec / 60)} 分钟` },
        { status: 429, headers: { "retry-after": String(retrySec) } },
      );
    }
    return NextResponse.json({ error: `当前密码不正确（剩余 ${r.remaining} 次）` }, { status: 400 });
  }

  loginRateClear(key);

  if (parsed.data.oldPassword === parsed.data.newPassword) {
    return NextResponse.json({ error: "新密码不能与当前密码相同" }, { status: 400 });
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(newHash, row.id);

  return NextResponse.json({ ok: true });
}
