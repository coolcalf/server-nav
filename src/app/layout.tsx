import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { AccentInitScript } from "@/components/accent-picker";
import { Toaster } from "sonner";
import { getDb, getSettings, DEFAULT_SETTINGS } from "@/lib/db";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const s = getSettings(getDb());
    const brand = s.brand_name || DEFAULT_SETTINGS.brand_name;
    const site = s.site_title || DEFAULT_SETTINGS.site_title;
    return {
      title: `${brand} · ${site}`,
      description: "个人服务器服务导航与管理",
    };
  } catch {
    return { title: "Server Hub · 服务导航" };
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <AccentInitScript />
      </head>
      <body className="min-h-screen">
        <ThemeProvider>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
