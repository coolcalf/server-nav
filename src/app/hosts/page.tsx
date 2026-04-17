import { getDb, getSettings } from "@/lib/db";
import { readSession } from "@/lib/auth";
import { NavBar } from "@/components/nav-bar";
import { HostsBrowser } from "@/components/hosts-browser";
import { ensureHostMonitor, getAllMetrics, getAllHostHistory } from "@/lib/host-monitor";
import type { Host } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HostsPage() {
  const session = await readSession();
  const authed = !!session;

  const db = getDb();
  const settings = getSettings(db);
  const rows = db.prepare("SELECT * FROM hosts ORDER BY sort_order, id").all() as Host[];
  const visible = authed ? rows : rows.filter((h) => !h.is_private);

  ensureHostMonitor();
  const metrics = getAllMetrics();
  const history = getAllHostHistory();

  return (
    <>
      <NavBar authed={authed} username={session?.sub} brand={settings.brand_name} />
      <main className="bg-grid">
        <section className="max-w-6xl mx-auto px-4 pt-14 pb-8">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">主机监控</h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-3 max-w-2xl">
            通过 Prometheus 兼容的 exporter 抓取被监控机的 CPU / 内存 / 磁盘 / 负载等指标。
            支持 <code className="text-xs bg-muted px-1 rounded">node_exporter</code>（Linux/Mac）与{" "}
            <code className="text-xs bg-muted px-1 rounded">windows_exporter</code>（Windows）。
          </p>
        </section>

        <section className="max-w-6xl mx-auto px-4 pb-20">
          <HostsBrowser
            initialHosts={visible}
            initialMetrics={metrics}
            initialHistory={history}
            authed={authed}
          />
        </section>
      </main>
    </>
  );
}
