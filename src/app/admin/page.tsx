import { readSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { AdminClient } from "./admin-client";
import { getDb, getSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  const settings = getSettings(getDb());
  return (
    <>
      <NavBar authed={true} username={session.sub} brand={settings.brand_name} />
      <main className="bg-grid min-h-[calc(100vh-3.5rem)]">
        <AdminClient />
      </main>
    </>
  );
}
