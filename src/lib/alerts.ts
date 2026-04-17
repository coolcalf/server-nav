import { getDb, getSettings } from "./db";

export type AlertSource = "host" | "service" | "test";

export type AlertRecord = {
  at: number;
  source: AlertSource;
  kind: string;
  targetId?: number | null;
  targetName?: string | null;
  text: string;
};

/** 发送 webhook 并把结果（成功或失败）写入 alert_events。返回实际发送结果。 */
export async function sendWebhookAndRecord(
  url: string,
  payload: Record<string, unknown>,
  meta: AlertRecord,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let ok = true;
  let error: string | undefined;
  let status: number | undefined;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    status = res.status;
    if (!res.ok) { ok = false; error = `HTTP ${res.status}`; }
  } catch (e) {
    ok = false;
    error = (e as Error).message || "network error";
  } finally {
    clearTimeout(timer);
  }
  try {
    getDb()
      .prepare(
        "INSERT INTO alert_events (at, source, kind, target_id, target_name, text, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        meta.at,
        meta.source,
        meta.kind,
        meta.targetId ?? null,
        meta.targetName ?? null,
        meta.text,
        ok ? 1 : 0,
        error ?? null,
      );
  } catch { /* ignore logging errors */ }
  return { ok, error, status };
}

/** 读取告警静默窗口（毫秒）。优先读数据库，降级到 env / 默认 10 分钟。最大 24 小时。 */
export function getSilenceMs(kind: "host" | "health"): number {
  const s = getSettings(getDb());
  const key = kind === "host" ? "host_alert_silence_minutes" : "health_alert_silence_minutes";
  const envKey = kind === "host" ? "HOST_ALERT_SILENCE_MS" : "HEALTH_ALERT_SILENCE_MS";
  const fromDb = Number(s[key]);
  if (Number.isFinite(fromDb) && fromDb >= 0) {
    return Math.min(fromDb, 24 * 60) * 60_000;
  }
  const fromEnv = Number(process.env[envKey]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 10 * 60_000;
}

/** 按保留期裁剪 alert_events，在 host-monitor 每轮清理时调用 */
export function pruneAlertEvents(): void {
  try {
    const s = getSettings(getDb());
    const days = Number(s.alert_history_retention_days);
    const keep = Number.isFinite(days) && days > 0 ? days : 30;
    const cutoff = Date.now() - keep * 86400_000;
    getDb().prepare("DELETE FROM alert_events WHERE at < ?").run(cutoff);
  } catch { /* ignore */ }
}
