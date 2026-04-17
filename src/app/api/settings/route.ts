import { NextResponse } from "next/server";
import { getDb, getSettings, setSettings, DEFAULT_SETTINGS } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  return NextResponse.json({ settings: getSettings(db) });
}

const minuteStr = z.string().regex(/^\d{1,4}$/, "请填 0~9999 的整数").optional();

const schema = z.object({
  brand_name: z.string().max(40).optional(),
  site_title: z.string().max(80).optional(),
  site_subtitle: z.string().max(120).optional(),
  welcome_public: z.string().max(300).optional(),
  welcome_authed: z.string().max(300).optional(),
  alert_webhook_url: z.string().max(500).optional().refine(
    (v) => !v || /^https?:\/\//i.test(v),
    { message: "必须是 http(s):// 开头的 URL" },
  ),
  host_alert_silence_minutes: minuteStr,
  health_alert_silence_minutes: minuteStr,
  alert_history_retention_days: minuteStr,
});

export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const patch: Record<string, string> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = (parsed.data as Record<string, string | undefined>)[k];
    if (typeof v === "string") patch[k] = v;
  }
  const db = getDb();
  setSettings(db, patch);
  return NextResponse.json({ settings: getSettings(db) });
}
