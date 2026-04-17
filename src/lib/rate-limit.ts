/**
 * 登录尝试速率限制器（进程内存，单进程有效）。
 * 策略：按 "ip|username" 做 key。
 * - 失败超过 MAX_FAILS 次后锁定 LOCK_MS 毫秒
 * - 锁定期内任何尝试都直接拒绝并返回剩余毫秒
 * - 成功登录应调用 clear() 清除计数
 *
 * 注意：Node 进程重启会清零；多实例部署需要外部存储（Redis）替换本模块。
 */

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 5);
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60_000);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60_000);

type Bucket = { fails: number; firstAt: number; lockedUntil: number };

const G = globalThis as unknown as { __loginBuckets?: Map<string, Bucket> };
function buckets(): Map<string, Bucket> {
  if (!G.__loginBuckets) G.__loginBuckets = new Map();
  return G.__loginBuckets;
}

export function loginRateCheck(key: string): { allowed: boolean; retryAfterMs?: number } {
  const b = buckets().get(key);
  const now = Date.now();
  if (!b) return { allowed: true };
  if (b.lockedUntil > now) return { allowed: false, retryAfterMs: b.lockedUntil - now };
  // 窗口过期则清零
  if (now - b.firstAt > WINDOW_MS) {
    buckets().delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

export function loginRateFail(key: string): { locked: boolean; retryAfterMs?: number; remaining: number } {
  const map = buckets();
  const now = Date.now();
  const b = map.get(key);
  if (!b || now - b.firstAt > WINDOW_MS) {
    map.set(key, { fails: 1, firstAt: now, lockedUntil: 0 });
    return { locked: false, remaining: MAX_FAILS - 1 };
  }
  b.fails += 1;
  if (b.fails >= MAX_FAILS) {
    b.lockedUntil = now + LOCK_MS;
    return { locked: true, retryAfterMs: LOCK_MS, remaining: 0 };
  }
  return { locked: false, remaining: MAX_FAILS - b.fails };
}

export function loginRateClear(key: string): void {
  buckets().delete(key);
}

export function extractClientIp(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("x-real-ip") || h.get("cf-connecting-ip") || "unknown";
}
