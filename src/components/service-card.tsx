"use client";
import { useState } from "react";
import {
  Copy,
  Lock,
  Eye,
  EyeOff,
  Globe,
  Server,
  Database,
  Cloud,
  Terminal,
  Activity,
  Boxes,
  ShieldCheck,
  Cpu,
  HardDrive,
  Network,
  Github,
  Mail,
  Film,
  Music,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import type { Service } from "@/lib/types";
import { Sparkline } from "./sparkline";

const ICONS: Record<string, React.ComponentType<{ size?: number | string; className?: string }>> = {
  Globe, Server, Database, Cloud, Terminal, Activity, Boxes, ShieldCheck, Cpu, HardDrive, Network,
  Github, Mail, Film, Music, FileText,
};

/** 来自服务端监控的状态 */
export type CardStatus = {
  ok: boolean;
  latency: number | null;
  type: "http" | "tcp" | "none";
  checkedAt?: number;
  error?: string;
} | null;

export function ServiceCard({
  service,
  authed,
  status: raw,
  history,
}: {
  service: Partial<Service> & { id: number; name: string; url: string };
  authed: boolean;
  status?: CardStatus;
  history?: (number | null)[];
}) {
  const [showCred, setShowCred] = useState(false);

  const checkType = (service.check_type ?? "http") as "http" | "tcp" | "none";
  const checkTarget = service.check_target || service.url;

  // 状态映射：无数据=pending；none=skip；其他看 ok
  const status: "pending" | "ok" | "bad" | "skip" =
    checkType === "none"
      ? "skip"
      : !raw
        ? "pending"
        : raw.ok
          ? "ok"
          : "bad";
  const latency = raw?.latency ?? null;

  const Icon = (service.icon && ICONS[service.icon]) || Globe;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`);
    } catch {
      toast.error("复制失败");
    }
  }

  function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
  }

  function openService() {
    window.open(service.url, "_blank", "noopener,noreferrer");
  }

  return (
    <a
      href={service.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // 允许中键/Ctrl+点击走浏览器默认；普通左键保持默认行为（新标签打开）
        // 这里不阻止，<a target=_blank> 自然行为即可。
        // 若点击发生在内部交互元素（复制/眼睛），由 stop() 在各自处理
        void e;
      }}
      className="card-surface p-4 flex flex-col gap-3 animate-fade-in cursor-pointer no-underline text-inherit select-text block"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-foreground shrink-0">
            <Icon size={20} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="font-medium truncate">{service.name}</h3>
              {service.is_private ? (
                <span className="badge" title="私有服务，未登录不可见">
                  <Lock size={10} /> 私有
                </span>
              ) : null}
            </div>
            {service.description ? (
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{service.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1.5">
          {history && history.length > 1 && status !== "skip" ? (
            <span
              className={status === "ok" ? "text-emerald-500/80" : status === "bad" ? "text-rose-500/70" : "text-muted-foreground"}
              title="最近延迟趋势（↓=掉线）"
            >
              <Sparkline data={history} width={64} height={16} />
            </span>
          ) : null}
          {latency != null && status === "ok" ? (
            <span className="text-[11px] text-muted-foreground">{latency}ms</span>
          ) : null}
          {status === "skip" ? null : (
            <span
              className={`dot ${status === "ok" ? "dot-ok" : status === "bad" ? "dot-bad" : "dot-pending"}`}
              title={
                status === "ok"
                  ? `在线 ${latency ?? "-"}ms（${checkType.toUpperCase()}）`
                  : status === "bad"
                    ? `离线或不可达（${checkType.toUpperCase()} ${checkTarget}）`
                    : "检测中"
              }
            />
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground truncate">
        {service.url}
      </div>

      {authed && (service.internal_url || service.credentials || service.notes) ? (
        <div
          className="rounded-lg bg-muted/60 border p-2.5 space-y-2 text-xs"
          onClick={stop}
        >
          {service.internal_url ? (
            <Row label="内网" value={service.internal_url} onCopy={() => copy(service.internal_url!, "内网地址")} onOpen={openService} openLabel={service.internal_url} />
          ) : null}
          {service.credentials ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">凭据</span>
                <div className="flex items-center gap-1">
                  <button className="btn btn-ghost !h-6 !px-2" onClick={(e) => { stop(e); setShowCred((v) => !v); }}>
                    {showCred ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button className="btn btn-ghost !h-6 !px-2" onClick={(e) => { stop(e); copy(service.credentials!, "凭据"); }}>
                    <Copy size={12} />
                  </button>
                </div>
              </div>
              <pre className={`whitespace-pre-wrap break-all text-[11px] ${showCred ? "" : "blur-sm select-none"}`}>
                {service.credentials}
              </pre>
            </div>
          ) : null}
          {service.notes ? (
            <div>
              <div className="text-muted-foreground mb-0.5">备注</div>
              <p className="whitespace-pre-wrap text-[11px]">{service.notes}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </a>
  );
}

function Row({ label, value, onCopy }: { label: string; value: string; onCopy: () => void; onOpen?: () => void; openLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="truncate font-mono text-[11px]">{value}</span>
      <button className="btn btn-ghost !h-6 !px-2" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onCopy(); }} title="复制">
        <Copy size={12} />
      </button>
    </div>
  );
}
