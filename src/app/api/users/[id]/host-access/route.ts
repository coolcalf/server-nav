import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { getUserHostAccess, addUserHostAccess, removeUserHostAccess } from "@/lib/mobile-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const userId = Number(params.id);
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  const access = getUserHostAccess(userId);
  // 附带主机/分组名称方便显示
  const enriched = access.map((a) => {
    let host_name: string | null = null;
    let group_name: string | null = null;
    if (a.host_id) {
      const h = db.prepare("SELECT name FROM hosts WHERE id = ?").get(a.host_id) as { name: string } | undefined;
      host_name = h?.name ?? null;
    }
    if (a.group_id) {
      const g = db.prepare("SELECT name FROM host_groups WHERE id = ?").get(a.group_id) as { name: string } | undefined;
      group_name = g?.name ?? null;
    }
    return { ...a, host_name, group_name };
  });

  return NextResponse.json({ access: enriched });
}

const addSchema = z.object({
  host_id: z.number().int().nullable().optional(),
  group_id: z.number().int().nullable().optional(),
}).refine(
  (d) => (d.host_id != null) !== (d.group_id != null),
  { message: "必须且只能指定 host_id 或 group_id 其中一个" },
);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const userId = Number(params.id);
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, { status: 400 });

  const record = addUserHostAccess(userId, parsed.data.host_id ?? null, parsed.data.group_id ?? null);
  return NextResponse.json({ access: record });
}

const deleteSchema = z.object({ access_id: z.number().int() });

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  removeUserHostAccess(parsed.data.access_id);
  return NextResponse.json({ ok: true });
}
