import { NextResponse } from "next/server";
import { z } from "zod";
import net from "node:net";

export const runtime = "nodejs";

const schema = z.object({
  /** 检查方式 */
  type: z.enum(["http", "tcp", "none"]).default("http"),
  /** http: 完整 URL；tcp: host:port；如果 type=http 可以只传 url 字段 */
  target: z.string().optional(),
  /** 兼容老调用：仅 url */
  url: z.string().optional(),
});

const TIMEOUT_MS = 5000;

/** 从 URL 推导 host 和 port（tcp 场景用） */
function deriveHostPort(input: string): { host: string; port: number } | null {
  // 先试作 host:port
  const mHp = /^([^\s/:]+):(\d{1,5})$/.exec(input.trim());
  if (mHp) {
    const port = Number(mHp[2]);
    if (port > 0 && port < 65536) return { host: mHp[1], port };
  }
  // 再试作完整 URL
  try {
    const u = new URL(input);
    const host = u.hostname;
    let port = u.port ? Number(u.port) : NaN;
    if (!port) {
      // 一些常见协议的默认端口
      const defaults: Record<string, number> = {
        "http:": 80, "https:": 443, "ftp:": 21, "ssh:": 22,
        "mysql:": 3306, "postgres:": 5432, "postgresql:": 5432,
        "redis:": 6379, "mongodb:": 27017, "mongodb+srv:": 27017,
      };
      port = defaults[u.protocol] ?? NaN;
    }
    if (host && port > 0) return { host, port };
  } catch { /* ignore */ }
  return null;
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; latency: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve({ ok, latency: Date.now() - start, error });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, (e as Error).message));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, (e as Error).message);
    }
  });
}

async function probeHttp(url: string) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
    return { ok: res.status < 500, status: res.status, latency: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 });

  const { type } = parsed.data;
  const target = parsed.data.target || parsed.data.url || "";

  if (type === "none") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  if (type === "tcp") {
    const hp = deriveHostPort(target);
    if (!hp) return NextResponse.json({ ok: false, error: "无法解析 host:port" }, { status: 400 });
    const r = await probeTcp(hp.host, hp.port);
    return NextResponse.json(r);
  }

  // http（默认）
  if (!target) return NextResponse.json({ ok: false, error: "missing url" }, { status: 400 });
  try {
    // 严格校验一下 URL
    new URL(target);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
  }
  const r = await probeHttp(target);
  return NextResponse.json(r);
}
