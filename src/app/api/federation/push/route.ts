import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isMaster, upsertSnapshot } from "@/lib/federation";
import type { AgentRow, AgentPushPayload } from "@/lib/federation";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/federation/push
 * Agent 将本地数据推送到 master。
 * 请求体为 AgentPushPayload（含 agent_key）。
 */
export async function POST(req: Request) {
  if (!isMaster()) {
    return NextResponse.json({ error: "此实例不是 master 模式" }, { status: 403 });
  }

  let body: AgentPushPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const agentKey = body.agent_key;
  if (!agentKey || typeof agentKey !== "string") {
    return NextResponse.json({ error: "缺少 agent_key" }, { status: 401 });
  }

  // 在 agents 表中查找匹配的 agent
  const db = getDb();
  const agents = db.prepare("SELECT * FROM agents WHERE enabled = 1").all() as AgentRow[];

  let matched: AgentRow | null = null;
  for (const a of agents) {
    if (bcrypt.compareSync(agentKey, a.key_hash)) {
      matched = a;
      break;
    }
  }

  if (!matched) {
    return NextResponse.json({ error: "无效的 agent_key" }, { status: 401 });
  }

  // 更新 last_seen_at
  db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(Date.now(), matched.id);

  // 存入内存快照
  upsertSnapshot(matched.id, matched.name, body);

  return NextResponse.json({ ok: true, agentId: matched.id });
}
