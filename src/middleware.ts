import { NextResponse, type NextRequest } from "next/server";

/* ================================================================
   全局中间件 —— 安全头 + API-only 模式 + 全局 IP 速率限制
   ================================================================ */

// ── API-only 模式：隐藏 Web 页面，只保留 API 端点 ──
const API_ONLY = (process.env.DISABLE_WEB_UI || "").trim().toLowerCase() === "true";

// ── 全局 IP 速率限制（针对认证端点） ──
const GLOBAL_IP_MAX = Number(process.env.GLOBAL_IP_MAX_REQUESTS || 30);
const GLOBAL_IP_WINDOW_MS = Number(process.env.GLOBAL_IP_WINDOW_MS || 60_000);

type IpBucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, IpBucket>();

// 定期清理过期桶（每 60 秒）
let lastCleanup = Date.now();
function cleanupIpBuckets() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [k, b] of ipBuckets) {
    if (b.resetAt <= now) ipBuckets.delete(k);
  }
}

function checkGlobalIpRate(ip: string): { allowed: boolean; retryAfterMs?: number } {
  cleanupIpBuckets();
  const now = Date.now();
  const b = ipBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + GLOBAL_IP_WINDOW_MS });
    return { allowed: true };
  }
  b.count++;
  if (b.count > GLOBAL_IP_MAX) {
    return { allowed: false, retryAfterMs: b.resetAt - now };
  }
  return { allowed: true };
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    req.ip ||
    "unknown"
  );
}

// 需要全局 IP 限速的认证端点
const AUTH_PATHS = [
  "/api/auth/login",
  "/api/auth/change-password",
  "/api/mobile/auth/login",
];

// Web 页面路径（API-only 模式时拦截）
const WEB_PAGE_PREFIXES = ["/login", "/admin", "/hosts"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── API-only 模式：拦截页面请求 ──
  if (API_ONLY) {
    // 首页
    if (pathname === "/") {
      return NextResponse.json(
        { error: "Web UI is disabled. Use the API endpoints instead.", api_docs: "/api" },
        { status: 403 },
      );
    }
    // 其他页面路径
    if (WEB_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      return NextResponse.json(
        { error: "Web UI is disabled." },
        { status: 403 },
      );
    }
  }

  // ── 全局 IP 速率限制（仅认证端点） ──
  if (AUTH_PATHS.some((p) => pathname === p)) {
    const ip = getClientIp(req);
    const gate = checkGlobalIpRate(ip);
    if (!gate.allowed) {
      const retrySec = Math.ceil((gate.retryAfterMs ?? 0) / 1000);
      return NextResponse.json(
        { error: `请求过于频繁，请 ${retrySec} 秒后重试` },
        {
          status: 429,
          headers: {
            "retry-after": String(retrySec),
            "x-ratelimit-limit": String(GLOBAL_IP_MAX),
          },
        },
      );
    }
  }

  // ── 安全响应头 ──
  const res = NextResponse.next();
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
  res.headers.set("X-XSS-Protection", "1; mode=block");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // 仅 API 响应禁止缓存敏感数据
  if (pathname.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
  }
  return res;
}

export const config = {
  matcher: [
    // 匹配所有路径，排除静态资源
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
