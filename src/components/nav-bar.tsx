"use client";
import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { AccentPicker } from "./accent-picker";
import { LogIn, LogOut, Settings, LayoutGrid, Server } from "lucide-react";
import { useRouter } from "next/navigation";

export function NavBar({ authed, username, brand = "Server Hub" }: { authed: boolean; username?: string; brand?: string }) {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
  }
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-background/70 border-b">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-primary text-primary-foreground">
            <LayoutGrid size={16} />
          </span>
          <span>{brand}</span>
        </Link>
        <nav className="flex items-center gap-1">
          <Link href="/hosts" className="btn btn-ghost">
            <Server size={16} />
            <span className="hidden sm:inline">主机</span>
          </Link>
          <AccentPicker />
          <ThemeToggle />
          {authed ? (
            <>
              <Link href="/admin" className="btn btn-ghost">
                <Settings size={16} />
                <span className="hidden sm:inline">管理</span>
              </Link>
              <button className="btn btn-outline" onClick={logout}>
                <LogOut size={16} />
                <span className="hidden sm:inline">{username ? `登出 ${username}` : "登出"}</span>
              </button>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary">
              <LogIn size={16} />
              <span>登录</span>
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
