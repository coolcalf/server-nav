"use client";
import { useEffect, useState } from "react";
import { Palette, Check } from "lucide-react";

const ACCENTS: { key: string; label: string; color: string }[] = [
  { key: "slate",   label: "石墨（默认）", color: "hsl(222 47% 20%)" },
  { key: "blue",    label: "蓝",         color: "hsl(221 83% 53%)" },
  { key: "emerald", label: "翠绿",       color: "hsl(160 84% 39%)" },
  { key: "rose",    label: "玫红",       color: "hsl(346 77% 50%)" },
  { key: "violet",  label: "紫罗兰",     color: "hsl(262 83% 58%)" },
  { key: "amber",   label: "琥珀",       color: "hsl(32 95% 44%)" },
];

const STORAGE_KEY = "accent-theme";

export function applyAccent(key: string) {
  const el = document.documentElement;
  if (key === "slate") el.removeAttribute("data-accent");
  else el.setAttribute("data-accent", key);
}

export function AccentPicker() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("slate");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) || "slate";
    setCurrent(saved);
    applyAccent(saved);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-accent-picker]")) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  function pick(key: string) {
    setCurrent(key);
    localStorage.setItem(STORAGE_KEY, key);
    applyAccent(key);
    setOpen(false);
  }

  return (
    <div className="relative" data-accent-picker>
      <button
        aria-label="选择配色"
        className="btn btn-ghost !h-9 !w-9 !p-0"
        onClick={() => setOpen((v) => !v)}
        title="配色主题"
      >
        <Palette size={16} />
      </button>
      {open ? (
        <div className="absolute right-0 top-10 w-48 card-surface p-2 z-50 animate-fade-in shadow-xl">
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              onClick={() => pick(a.key)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-sm text-left"
            >
              <span className="w-4 h-4 rounded-full border" style={{ background: a.color }} />
              <span className="flex-1">{a.label}</span>
              {current === a.key ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 防 FOUC：在 <head> 里尽早执行，读取 localStorage 并打上 data-accent */
export function AccentInitScript() {
  const code = `
(function(){
  try {
    var k = localStorage.getItem('${STORAGE_KEY}');
    if (k && k !== 'slate') document.documentElement.setAttribute('data-accent', k);
  } catch (e) {}
})();
  `.trim();
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
