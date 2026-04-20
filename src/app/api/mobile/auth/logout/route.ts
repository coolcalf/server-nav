import { NextResponse } from "next/server";
import { requireMobileAuth, revokeApiToken } from "@/lib/mobile-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = requireMobileAuth(req);
  if (session instanceof Response) return session;
  revokeApiToken(session.tokenId, session.uid);
  return NextResponse.json({ ok: true });
}
