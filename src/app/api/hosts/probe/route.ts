import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { probeOnce } from "@/lib/host-monitor";

export const runtime = "nodejs";

const schema = z.object({
  exporter_url: z.string().url().max(500),
  exporter_type: z.enum(["auto", "node", "windows"]).optional(),
  auth_header: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const m = await probeOnce(parsed.data.exporter_url, parsed.data.exporter_type ?? "auto", parsed.data.auth_header ?? null);
  return NextResponse.json({ metrics: m });
}
