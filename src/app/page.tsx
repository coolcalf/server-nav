import { getDb, getSettings } from "@/lib/db";
import { readSession } from "@/lib/auth";
import { NavBar } from "@/components/nav-bar";
import { HomeBrowser } from "@/components/home-browser";
import { ensureHealthMonitor, getAllStatuses, getAllHistory } from "@/lib/health-monitor";
import type { Service, Category } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await readSession();
  const authed = !!session;

  const db = getDb();
  const settings = getSettings(db);
  const categories = db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all() as Category[];
  const services = db
    .prepare("SELECT * FROM services ORDER BY sort_order, id")
    .all() as Service[];

  const visible = authed ? services : services.filter((s) => !s.is_private);

  // 启动后台监控并读取当前缓存（首屏就带状态渲染）
  ensureHealthMonitor();
  const statuses = getAllStatuses();
  const history = getAllHistory();

  return (
    <>
      <NavBar authed={authed} username={session?.sub} brand={settings.brand_name} />
      <main className="bg-grid">
        <section className="max-w-6xl mx-auto px-4 pt-14 pb-8">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            {settings.site_title}
            {settings.site_subtitle ? (
              <span className="text-muted-foreground"> · {settings.site_subtitle}</span>
            ) : null}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {authed
              ? (settings.welcome_authed || "").replaceAll("{{username}}", session?.sub ?? "")
              : settings.welcome_public}
          </p>
        </section>

        <section className="max-w-6xl mx-auto px-4 pb-20">
          <HomeBrowser
            services={visible}
            categories={categories}
            authed={authed}
            initialStatuses={statuses}
            initialHistory={history}
          />
        </section>
      </main>
    </>
  );
}
