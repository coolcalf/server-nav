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

/* ── CORS 配置（仅对 /api/mobile/* 生效） ──
   MOBILE_CORS_ORIGINS 支持：
     - 逗号分隔的白名单：https://app.example.com,https://m.example.com
     - "*"：允许任意源（不支持携带凭证，但移动端使用 Bearer token 不需要 cookie）
   默认 "*"，方便局域网/自部署场景直接跑起来。
*/
const MOBILE_CORS_ORIGINS = (process.env.MOBILE_CORS_ORIGINS ?? "*").trim();
const MOBILE_CORS_LIST = MOBILE_CORS_ORIGINS === "*"
  ? null
  : MOBILE_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

function resolveCorsOrigin(reqOrigin: string | null): string | null {
  if (!reqOrigin) return null;
  if (MOBILE_CORS_LIST === null) return "*";
  return MOBILE_CORS_LIST.includes(reqOrigin) ? reqOrigin : null;
}

function applyCorsHeaders(res: NextResponse, origin: string) {
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "authorization,content-type");
  res.headers.set("Access-Control-Max-Age", "600");
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── CORS 预检 / 响应注入（/api/mobile/*） ──
  const isMobileApi = pathname.startsWith("/api/mobile/");
  const reqOrigin = req.headers.get("origin");
  const corsOrigin = isMobileApi ? resolveCorsOrigin(reqOrigin) : null;

  if (isMobileApi && req.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    if (corsOrigin) applyCorsHeaders(res, corsOrigin);
    return res;
  }

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
  // ── CORS 响应头注入 ──
  if (corsOrigin) applyCorsHeaders(res, corsOrigin);
  return res;
}

export const config = {
  matcher: [
    // 匹配所有路径，排除静态资源
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
