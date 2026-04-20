import { NextResponse } from "next/server";
import { requireMobileAuth, listApiTokens } from "@/lib/mobile-auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = requireMobileAuth(req);
  if (session instanceof Response) return session;
  const tokens = listApiTokens(session.uid);
  return NextResponse.json({
    user: { id: session.uid, username: session.sub, role: session.role },
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      last_used_at: t.last_used_at,
      expires_at: t.expires_at,
      created_at: t.created_at,
    })),
  });
}
