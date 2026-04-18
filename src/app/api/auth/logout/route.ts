import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const setCookie = destroySession();
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", setCookie);
  return res;
}
