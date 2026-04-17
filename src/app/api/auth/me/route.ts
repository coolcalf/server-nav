import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readSession();
  if (!s) return NextResponse.json({ authed: false, username: null, role: null, must_change_password: false });
  const db = getDb();
  const row = db.prepare("SELECT must_change_password FROM users WHERE username = ?").get(s.sub) as
    | { must_change_password: number } | undefined;
  return NextResponse.json({
    authed: true,
    username: s.sub,
    role: s.role,
    must_change_password: !!row?.must_change_password,
  });
}
