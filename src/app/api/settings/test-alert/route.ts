import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, getSettings } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { sendWebhookAndRecord } from "@/lib/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  url: z.string().url().optional(),
});

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const url = (parsed.data.url || getSettings(getDb()).alert_webhook_url || "").trim();
  if (!url) return NextResponse.json({ error: "未配置 Webhook URL" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "URL 必须以 http(s):// 开头" }, { status: 400 });

  const text = "✅ Server Hub 测试消息：这是一条告警推送联通性测试。";
  const now = Date.now();
  const payload = {
    kind: "test",
    at: new Date(now).toISOString(),
    text,
    content: text,
    msgtype: "text",
    msg_type: "text",
    text_content: text,
  };
  const r = await sendWebhookAndRecord(url, payload, {
    at: now, source: "test", kind: "test",
    targetId: null, targetName: null, text,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error || "发送失败", status: r.status }, { status: 502 });
  return NextResponse.json({ ok: true, status: r.status });
}
