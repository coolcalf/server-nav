import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { getUserHostAccess, addUserHostAccess, removeUserHostAccess } from "@/lib/mobile-auth";
import { isMaster, getAllSnapshots } from "@/lib/federation";
import type { AgentRow } from "@/lib/federation";

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
  // 附带主机/分组/节点名称方便显示
  const enriched = access.map((a) => {
    let host_name: string | null = null;
    let group_name: string | null = null;
    let agent_name: string | null = null;
    if (a.host_id) {
      const h = db.prepare("SELECT name FROM hosts WHERE id = ?").get(a.host_id) as { name: string } | undefined;
      host_name = h?.name ?? null;
    }
    if (a.group_id) {
      const g = db.prepare("SELECT name FROM host_groups WHERE id = ?").get(a.group_id) as { name: string } | undefined;
      group_name = g?.name ?? null;
    }
    let remote_host_name: string | null = null;
    if (a.agent_id) {
      const ag = db.prepare("SELECT name FROM agents WHERE id = ?").get(a.agent_id) as { name: string } | undefined;
      agent_name = ag?.name ?? null;
      if (a.remote_host_id != null) {
        const snap = getAllSnapshots().find((s) => s.agentId === a.agent_id);
        const rh = snap?.hosts.find((h) => h.id === a.remote_host_id);
        remote_host_name = rh?.name ?? null;
      }
    }
    return { ...a, host_name, group_name, agent_name, remote_host_name };
  });

  // 联邦主控模式时，返回可选的 agent 列表和远程主机列表供下拉用
  const agents: { id: string; name: string }[] = [];
  const remoteHosts: { agentId: string; hosts: { id: number; name: string }[] }[] = [];
  if (isMaster()) {
    const rows = db.prepare("SELECT id, name FROM agents WHERE enabled = 1 ORDER BY sort_order, name").all() as AgentRow[];
    for (const r of rows) agents.push({ id: r.id, name: r.name });
    for (const s of getAllSnapshots()) {
      const ag = rows.find((r) => r.id === s.agentId);
      if (!ag) continue;
      remoteHosts.push({
        agentId: s.agentId,
        hosts: s.hosts.map((h) => ({ id: h.id, name: h.name })),
      });
    }
  }

  return NextResponse.json({ access: enriched, agents, remoteHosts });
}

const addSchema = z.object({
  host_id: z.number().int().nullable().optional(),
  group_id: z.number().int().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  remote_host_id: z.number().int().nullable().optional(),
}).refine(
  (d) => {
    // host_id 单独 / group_id 单独 / agent_id 单独 / agent_id + remote_host_id
    if (d.host_id != null) return d.group_id == null && d.agent_id == null && d.remote_host_id == null;
    if (d.group_id != null) return d.host_id == null && d.agent_id == null && d.remote_host_id == null;
    if (d.agent_id != null) return d.host_id == null && d.group_id == null; // remote_host_id 可有可无
    return false;
  },
  { message: "参数错误：必须指定 host_id / group_id / agent_id(可含 remote_host_id) 其中一种" },
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

  const record = addUserHostAccess(userId, parsed.data.host_id ?? null, parsed.data.group_id ?? null, parsed.data.agent_id ?? null, parsed.data.remote_host_id ?? null);
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
