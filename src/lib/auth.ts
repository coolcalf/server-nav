import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "auth_token";
const ALG = "HS256";

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET 未设置或过短，请在 .env 中配置");
  }
  return new TextEncoder().encode(s);
}

export type Role = "admin" | "viewer";

function shouldUseSecureCookie() {
  return process.env.COOKIE_SECURE === "true";
}

function serializeCookie(
  name: string,
  value: string,
  opts: { httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string; maxAge?: number },
): string {
  let str = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.path) str += `; Path=${opts.path}`;
  if (opts.maxAge !== undefined) {
    str += `; Max-Age=${opts.maxAge}`;
    const expires = new Date(Date.now() + opts.maxAge * 1000);
    str += `; Expires=${expires.toUTCString()}`;
  }
  if (opts.secure) str += "; Secure";
  if (opts.httpOnly) str += "; HttpOnly";
  if (opts.sameSite) str += `; SameSite=${opts.sameSite}`;
  return str;
}

export async function createSession(payload: { sub: string; uid: number; role: Role }): Promise<string> {
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
  return serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function destroySession(): string {
  return serializeCookie(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
  });
}

export type Session = { sub: string; uid: number; role: Role };

export async function readSession(): Promise<Session | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const role = (payload.role === "viewer" ? "viewer" : "admin") as Role;
    return { sub: String(payload.sub), uid: Number(payload.uid), role };
  } catch {
    return null;
  }
}

export async function requireAuth() {
  const s = await readSession();
  if (!s) throw new Response("Unauthorized", { status: 401 });
  return s;
}

/** 需要管理员。未登录返回 401；登录但非 admin 返回 403 */
export async function requireAdmin(): Promise<Session | Response> {
  const s = await readSession();
  if (!s) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  if (s.role !== "admin") return new Response(JSON.stringify({ error: "需要管理员权限" }), { status: 403, headers: { "content-type": "application/json" } });
  return s;
}

export { COOKIE_NAME };
