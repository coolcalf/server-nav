import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { isMaster, getItemOverrides, setItemVisibility, removeItemVisibility, getSnapshot } from "@/lib/federation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/federation/agents/visibility?agent_id=xxx — 获取某节点的单项可见性覆盖 + 当前推送的 host/service 列表 */
export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "缺少 agent_id" }, { status: 400 });
  }

  const snap = getSnapshot(agentId);
  const overrides = getItemOverrides(agentId);

  // 把 overrides Map 转成数组方便前端消费
  const overrideList: Array<{ item_type: string; remote_id: number; public_visible: boolean }> = [];
  for (const [key, val] of overrides) {
    const [itemType, remoteIdStr] = key.split(":");
    overrideList.push({ item_type: itemType, remote_id: Number(remoteIdStr), public_visible: val });
  }

  return NextResponse.json({
    hosts: snap?.hosts.map((h) => ({ id: h.id, name: h.name })) ?? [],
    services: snap?.services.map((s) => ({ id: s.id, name: s.name })) ?? [],
    overrides: overrideList,
  });
}

const patchSchema = z.object({
  agent_id: z.string().min(1),
  item_type: z.enum(["host", "service"]),
  remote_id: z.number().int(),
  /** true=公开, false=仅登录, null=删除覆盖（恢复跟随节点默认） */
  public_visible: z.boolean().nullable(),
});

/** PATCH /api/federation/agents/visibility — 设置/删除单项可见性覆盖 */
export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof Response) return gate;

  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { agent_id, item_type, remote_id, public_visible } = parsed.data;

  if (public_visible === null) {
    removeItemVisibility(agent_id, item_type, remote_id);
  } else {
    setItemVisibility(agent_id, item_type, remote_id, public_visible);
  }

  return NextResponse.json({ ok: true });
}
