"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccentPicker } from "@/components/accent-picker";
import { LogIn, LayoutGrid, ArrowLeft } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState("Server Hub");

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j?.settings?.brand_name) setBrand(j.settings.brand_name); })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "登录失败");
      toast.success(`欢迎回来，${j.username}`);
      router.push("/admin");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-grid flex items-center justify-center p-4">
      <Link
        href="/"
        className="absolute top-4 left-4 btn btn-ghost"
        title="返回首页"
      >
        <ArrowLeft size={16} />
        <span className="hidden sm:inline">返回首页</span>
      </Link>
      <div className="absolute top-4 right-4 flex items-center gap-1"><AccentPicker /><ThemeToggle /></div>
      <div className="w-full max-w-sm card-surface p-6 sm:p-8 animate-fade-in">
        <Link href="/" className="inline-flex items-center gap-2 font-semibold mb-6">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-primary text-primary-foreground">
            <LayoutGrid size={16} />
          </span>
          <span>{brand}</span>
        </Link>
        <h1 className="text-xl font-semibold">登录管理后台</h1>
        <p className="text-sm text-muted-foreground mt-1">登录后可管理服务并查看隐藏字段。</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="label">用户名</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div>
            <label className="label">密码</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            <LogIn size={16} /> {loading ? "登录中…" : "登录"}
          </button>
        </form>

        <p className="text-xs text-muted-foreground mt-6 text-center">
          初始账号在 <code>.env</code> 的 <code>ADMIN_USERNAME / ADMIN_PASSWORD</code> 中配置。
        </p>

        <div className="mt-4 text-center">
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft size={12} /> 返回首页
          </Link>
        </div>
      </div>
    </main>
  );
}
