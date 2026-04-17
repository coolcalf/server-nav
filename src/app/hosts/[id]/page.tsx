import { notFound } from "next/navigation";
import { getDb, getSettings } from "@/lib/db";
import { readSession } from "@/lib/auth";
import { NavBar } from "@/components/nav-bar";
import { HostDetailClient } from "@/components/host-detail-client";
import { ensureHostMonitor, getAllMetrics, queryHostHistory } from "@/lib/host-monitor";
import type { Host } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HostDetailPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const session = await readSession();
  const authed = !!session;

  const db = getDb();
  const settings = getSettings(db);
  const host = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as Host | undefined;
  if (!host) notFound();
  if (host.is_private && !authed) notFound();

  ensureHostMonitor();
  const metrics = getAllMetrics()[id];
  const initialPoints = queryHostHistory(id, "1h");

  return (
    <>
      <NavBar authed={authed} username={session?.sub} brand={settings.brand_name} />
      <main className="bg-grid">
        <section className="max-w-6xl mx-auto px-4 pt-10 pb-20">
          <HostDetailClient
            host={host}
            initialMetrics={metrics}
            initialPoints={initialPoints}
            authed={authed}
          />
        </section>
      </main>
    </>
  );
}
