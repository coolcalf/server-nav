"use client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, GripVertical, FolderPlus, Lock, Globe, Save, X, Settings as SettingsIcon, Download, Upload, KeyRound, AlertTriangle, ListPlus, Send, Bell, Trash } from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragEndEvent, DragOverEvent, DragStartEvent, DragOverlay, useDroppable,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Service, Category } from "@/lib/types";

const ICON_CHOICES = [
  "Globe", "Server", "Database", "Cloud", "Terminal", "Activity",
  "Boxes", "ShieldCheck", "Cpu", "HardDrive", "Network",
  "Github", "Mail", "Film", "Music", "FileText",
];

type Data = { services: Service[]; categories: Category[]; authed: boolean };

export function AdminClient() {
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState<Partial<Service> | null>(null);
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [mustChange, setMustChange] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setMustChange(!!j.must_change_password))
      .catch(() => {});
  }, []);

  async function exportBackup() {
    try {
      const r = await fetch("/api/backup/export");
      if (!r.ok) throw new Error("导出失败");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `server-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("已下载备份");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function reload() {
    const r = await fetch("/api/services", { cache: "no-store" });
    const j = await r.json();
    setData(j);
  }
  useEffect(() => { reload(); }, []);

  const grouped = useMemo(() => {
    const g = new Map<number | "none", Service[]>();
    if (!data) return g;
    for (const s of data.services) {
      const k = s.category_id ?? "none";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(s);
    }
    for (const [, list] of g) list.sort((a, b) => a.sort_order - b.sort_order);
    return g;
  }, [data]);

  async function onDelete(id: number) {
    if (!confirm("确认删除该服务？")) return;
    const r = await fetch(`/api/services/${id}`, { method: "DELETE" });
    if (r.ok) { toast.success("已删除"); reload(); } else { toast.error("删除失败"); }
  }

  /** 持久化：把涉及到的分类内所有 item 的 (category_id, sort_order) 上报 */
  async function persistReorder(affected: Map<number | "none", Service[]>) {
    const items: { id: number; category_id: number | null; sort_order: number }[] = [];
    for (const [key, list] of affected) {
      const cid = key === "none" ? null : key;
      list.forEach((s, i) => items.push({ id: s.id, category_id: cid, sort_order: i }));
    }
    const r = await fetch("/api/services/reorder", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }),
    });
    if (!r.ok) { toast.error("排序保存失败"); reload(); }
  }

  /* ----- 跨分类拖拽：统一在顶层 DndContext 处理 ----- */
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function findContainerOfId(id: string | number): number | "none" | null {
    if (!data) return null;
    // 容器自身 id：cat-<id> 或 cat-none
    if (typeof id === "string" && id.startsWith("cat-")) {
      const rest = id.slice(4);
      return rest === "none" ? "none" : Number(rest);
    }
    const numId = typeof id === "number" ? id : Number(id);
    const svc = data.services.find((s) => s.id === numId);
    if (!svc) return null;
    return svc.category_id ?? "none";
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  /** 拖到另一个容器时：乐观移动 item 到目标容器末尾或指定位置 */
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !data) return;
    const from = findContainerOfId(active.id);
    const to = findContainerOfId(over.id);
    if (from == null || to == null || from === to) return;

    setData((d) => {
      if (!d) return d;
      const svc = d.services.find((s) => s.id === Number(active.id));
      if (!svc) return d;
      const cid = to === "none" ? null : to;
      // 重建 services：先移除旧位置（by id 不变），把其 category_id 改成目标，并放到目标末尾
      const others = d.services.filter((s) => s.id !== svc.id);
      // 目标容器末尾位置
      const targetList = others.filter((s) => (s.category_id ?? "none") === to);
      const updated: Service = { ...svc, category_id: cid, sort_order: targetList.length };
      return { ...d, services: [...others, updated] };
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || !data) return;
    const activeContainer = findContainerOfId(active.id);
    const overContainer = findContainerOfId(over.id);
    if (activeContainer == null || overContainer == null) return;

    // 计算新顺序：分别为 activeContainer 和 overContainer 构建排序后的 list
    // 因为 onDragOver 已经把项目移到了目标容器，这里只需要在目标容器内 arrayMove
    setData((d) => {
      if (!d) return d;
      const byCat = new Map<number | "none", Service[]>();
      for (const s of d.services) {
        const k = s.category_id ?? "none";
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k)!.push(s);
      }
      for (const [, list] of byCat) list.sort((a, b) => a.sort_order - b.sort_order);

      const list = byCat.get(overContainer) ?? [];
      const oldIndex = list.findIndex((s) => s.id === Number(active.id));
      // over 可能是容器 id（空分类或 drop 到容器底部）
      let newIndex = list.findIndex((s) => s.id === Number(over.id));
      if (newIndex < 0) newIndex = list.length - 1;
      const reordered = oldIndex >= 0 && newIndex >= 0 ? arrayMove(list, oldIndex, newIndex) : list;
      byCat.set(overContainer, reordered);

      // 写回 sort_order
      const nextServices: Service[] = [];
      for (const [key, arr] of byCat) {
        arr.forEach((s, i) => nextServices.push({ ...s, category_id: key === "none" ? null : key, sort_order: i }));
      }

      // 异步持久化（affected 包含两个分类）
      const affected = new Map<number | "none", Service[]>();
      affected.set(overContainer, byCat.get(overContainer) ?? []);
      if (activeContainer !== overContainer) {
        affected.set(activeContainer, byCat.get(activeContainer) ?? []);
      }
      void persistReorder(affected);

      return { ...d, services: nextServices };
    });
  }

  const activeService = activeId != null && data ? data.services.find((s) => s.id === activeId) ?? null : null;

  if (!data) return <div className="max-w-6xl mx-auto px-4 py-10 text-muted-foreground">加载中…</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">管理</h1>
          <p className="text-sm text-muted-foreground mt-0.5">新增、编辑、拖拽排序你的服务。</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-outline" onClick={() => setPwdOpen(true)}>
            <KeyRound size={16} /> 修改密码
          </button>
          <button className="btn btn-outline" onClick={exportBackup}>
            <Download size={16} /> 导出
          </button>
          <button className="btn btn-outline" onClick={() => setImportOpen(true)}>
            <Upload size={16} /> 导入
          </button>
          <button className="btn btn-outline" onClick={() => setAlertsOpen(true)}>
            <Bell size={16} /> 告警历史
          </button>
          <button className="btn btn-outline" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={16} /> 站点设置
          </button>
          <button className="btn btn-outline" onClick={() => setCatDialogOpen(true)}>
            <FolderPlus size={16} /> 分类
          </button>
          <button className="btn btn-outline" onClick={() => setBulkOpen(true)}>
            <ListPlus size={16} /> 批量导入
          </button>
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            <Plus size={16} /> 新增服务
          </button>
        </div>
      </div>

      {mustChange ? (
        <div className="card-surface border-amber-500/40 bg-amber-500/5 p-3 mb-6 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <div className="font-medium">你还在使用默认或首次设置的密码。</div>
            <div className="text-muted-foreground text-xs mt-0.5">建议立即修改为强密码，避免泄漏风险。</div>
          </div>
          <button className="btn btn-primary" onClick={() => setPwdOpen(true)}>
            <KeyRound size={14} /> 立即修改
          </button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="space-y-8">
          {data.categories.map((cat) => (
            <CategorySection
              key={cat.id}
              containerId={`cat-${cat.id}`}
              title={cat.name}
              items={grouped.get(cat.id) ?? []}
              onEdit={setEditing}
              onDelete={onDelete}
            />
          ))}
          <CategorySection
            containerId="cat-none"
            title="未分类"
            items={grouped.get("none") ?? []}
            onEdit={setEditing}
            onDelete={onDelete}
          />
        </div>
        <DragOverlay>
          {activeService ? (
            <div className="card-surface p-3 flex items-center gap-3 shadow-2xl cursor-grabbing">
              <GripVertical size={16} className="text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{activeService.name}</div>
                <div className="text-xs text-muted-foreground truncate">{activeService.url}</div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {editing !== null ? (
        <ServiceDialog
          initial={editing}
          categories={data.categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}

      {catDialogOpen ? (
        <CategoryDialog
          categories={data.categories}
          onClose={() => setCatDialogOpen(false)}
          onChanged={() => reload()}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      ) : null}

      {alertsOpen ? (
        <AlertsHistoryDialog onClose={() => setAlertsOpen(false)} />
      ) : null}

      {pwdOpen ? (
        <ChangePasswordDialog
          onClose={() => setPwdOpen(false)}
          onChanged={() => { setPwdOpen(false); setMustChange(false); }}
        />
      ) : null}

      {importOpen ? (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); reload(); }}
        />
      ) : null}

      {bulkOpen ? (
        <BulkAddDialog
          onClose={() => setBulkOpen(false)}
          onDone={() => { setBulkOpen(false); reload(); }}
        />
      ) : null}
    </div>
  );
}

/* -------------------- 批量导入 URL 对话框 -------------------- */

function BulkAddDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [defaultCat, setDefaultCat] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return toast.error("请输入至少一行");

    const items: Array<{ name?: string; url: string; category_name?: string }> = [];
    const errs: string[] = [];
    for (const [idx, raw] of lines.entries()) {
      // 支持：
      //   https://...
      //   名称 | https://...
      //   名称 | https://... | 分类
      const parts = raw.split("|").map((p) => p.trim());
      let name: string | undefined;
      let url: string | undefined;
      let cat: string | undefined;
      if (parts.length === 1) {
        url = parts[0];
      } else if (parts.length === 2) {
        name = parts[0] || undefined;
        url = parts[1];
      } else {
        name = parts[0] || undefined;
        url = parts[1];
        cat = parts[2] || undefined;
      }
      if (!url || !/^https?:\/\//i.test(url)) {
        errs.push(`第 ${idx + 1} 行解析失败：${raw}`);
        continue;
      }
      items.push({ name, url, category_name: cat });
    }
    if (errs.length) return toast.error(errs.slice(0, 3).join("\n"));
    if (items.length === 0) return toast.error("没有有效的 URL");

    setBusy(true);
    try {
      const r = await fetch("/api/services/bulk", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, default_category_name: defaultCat.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "导入失败");
      toast.success(`已导入 ${j.created} 条`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">批量导入 URL</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">每行一条。支持格式：</label>
              <pre className="text-[11px] bg-muted rounded p-2 text-muted-foreground">{`https://grafana.local:3000
Grafana | https://grafana.local:3000
Grafana | https://grafana.local:3000 | 监控`}</pre>
            </div>
            <div>
              <textarea
                className="input font-mono text-xs"
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div>
              <label className="label">默认分类名（行里未指定时使用，留空=未分类）</label>
              <input className="input" value={defaultCat} onChange={(e) => setDefaultCat(e.target.value)} placeholder="常用" />
            </div>
            <p className="text-xs text-muted-foreground">
              导入的卡片默认：图标 Globe、HTTP 健康检查、告警开启、非私有。导入后可单条编辑调整。
            </p>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>
              <ListPlus size={14} /> {busy ? "导入中…" : "开始导入"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 修改密码对话框 -------------------- */

function ChangePasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [oldPwd, setOld] = useState("");
  const [newPwd, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (newPwd.length < 6) return toast.error("新密码至少 6 位");
    if (newPwd !== confirm) return toast.error("两次输入不一致");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "修改失败");
      toast.success("密码已更新");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-sm p-5 sm:p-6 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">修改密码</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label">当前密码</label>
              <input className="input" type="password" value={oldPwd} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" />
            </div>
            <div>
              <label className="label">新密码（至少 6 位）</label>
              <input className="input" type="password" value={newPwd} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" />
            </div>
            <div>
              <label className="label">确认新密码</label>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || !oldPwd || !newPwd || !confirm}>
              <Save size={14} /> {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 导入对话框 -------------------- */

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [busy, setBusy] = useState(false);

  function onFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.onerror = () => toast.error("读取文件失败");
    reader.readAsText(f);
  }

  async function submit() {
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return toast.error("JSON 解析失败"); }
    if (mode === "replace" && !confirm("替换模式会清空当前所有分类、服务与主机，确定继续？")) return;

    setBusy(true);
    try {
      const r = await fetch("/api/backup/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(payload as object), mode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "导入失败");
      toast.success(`已导入：分类 ${j.imported.categories}，服务 ${j.imported.services}，主机 ${j.imported.hosts ?? 0}`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">导入备份</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">选择 JSON 文件</label>
              <input
                type="file" accept="application/json,.json"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-transparent file:bg-muted file:px-3 file:py-1.5 file:text-sm hover:file:bg-muted/70"
              />
            </div>
            <div>
              <label className="label">或直接粘贴 JSON</label>
              <textarea className="input font-mono text-xs" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"kind":"server-hub-backup", ...}' />
            </div>
            <div>
              <label className="label">导入模式</label>
              <div className="flex gap-4 text-sm">
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
                  <span>替换（清空后导入）</span>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name="mode" checked={mode === "merge"} onChange={() => setMode("merge")} />
                  <span>合并（分类按名称合并，服务追加）</span>
                </label>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>
              <Upload size={14} /> {busy ? "导入中…" : "开始导入"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 站点设置对话框 -------------------- */

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({
    brand_name: "", site_title: "", site_subtitle: "", welcome_public: "", welcome_authed: "",
    alert_webhook_url: "",
    host_alert_silence_minutes: "10", health_alert_silence_minutes: "10", alert_history_retention_days: "30",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function sendTest() {
    setTesting(true);
    try {
      const r = await fetch("/api/settings/test-alert", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: form.alert_webhook_url?.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      toast.success(`测试消息已发送${j?.status ? `（${j.status}）` : ""}`);
    } catch (e) {
      toast.error(`发送失败：${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { setForm(j.settings); setLoading(false); });
  }, []);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json()).error || "保存失败");
      toast.success("已保存");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">站点设置</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="label">品牌名（导航栏左上角、登录页 Logo、浏览器标题）</label>
                <input className="input" value={form.brand_name ?? ""} onChange={(e) => set("brand_name", e.target.value)} placeholder="Server Hub" />
              </div>
              <div>
                <label className="label">主标题（首页 H1）</label>
                <input className="input" value={form.site_title ?? ""} onChange={(e) => set("site_title", e.target.value)} placeholder="服务导航" />
              </div>
              <div>
                <label className="label">副标题（主标题后的浅色文字）</label>
                <input className="input" value={form.site_subtitle ?? ""} onChange={(e) => set("site_subtitle", e.target.value)} placeholder="Server Hub" />
              </div>
              <div>
                <label className="label">未登录访客文案</label>
                <textarea className="input" rows={2} value={form.welcome_public ?? ""} onChange={(e) => set("welcome_public", e.target.value)} />
              </div>
              <div>
                <label className="label">已登录欢迎语（支持 <code className="text-xs bg-muted px-1 rounded">{"{{username}}"}</code>）</label>
                <textarea className="input" rows={2} value={form.welcome_authed ?? ""} onChange={(e) => set("welcome_authed", e.target.value)} />
              </div>
              <div>
                <label className="label">
                  告警 Webhook（Discord / Slack / 飞书 / 企业微信 / 自定义均可，留空关闭）
                </label>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    value={form.alert_webhook_url ?? ""}
                    onChange={(e) => set("alert_webhook_url", e.target.value)}
                    placeholder="https://discord.com/api/webhooks/... 或 https://open.feishu.cn/..."
                  />
                  <button
                    type="button"
                    className="btn btn-outline shrink-0"
                    onClick={sendTest}
                    disabled={testing || !form.alert_webhook_url?.trim()}
                    title="立即向该 Webhook 发送一条测试消息"
                  >
                    <Send size={14} /> {testing ? "发送中…" : "测试"}
                  </button>
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  服务/主机连续 2 轮失败后触发告警，连续 2 轮恢复后发送恢复消息。
                  Payload 同时包含 <code>text / content / msgtype</code> 字段以兼容常见机器人。
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="label">主机告警静默（分钟）</label>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form.host_alert_silence_minutes ?? ""}
                    onChange={(e) => set("host_alert_silence_minutes", e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="10"
                  />
                </div>
                <div>
                  <label className="label">服务告警静默（分钟）</label>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form.health_alert_silence_minutes ?? ""}
                    onChange={(e) => set("health_alert_silence_minutes", e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="10"
                  />
                </div>
                <div>
                  <label className="label">告警历史保留（天）</label>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form.alert_history_retention_days ?? ""}
                    onChange={(e) => set("alert_history_retention_days", e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="30"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
              <Save size={14} /> {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 告警历史对话框 -------------------- */

type AlertEvent = {
  id: number; at: number; source: "host" | "service" | "test";
  kind: string; target_id: number | null; target_name: string | null;
  text: string; ok: boolean; error: string | null;
};

function AlertsHistoryDialog({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [source, setSource] = useState<"" | "host" | "service" | "test">("");
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    setEvents(null);
    const params = new URLSearchParams({ limit: "200" });
    if (source) params.set("source", source);
    const r = await fetch(`/api/alerts?${params.toString()}`, { cache: "no-store" });
    const j = await r.json();
    setEvents(Array.isArray(j?.events) ? j.events : []);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source]);

  async function clearAll() {
    if (!confirm("确定清空所有告警历史？此操作不可恢复。")) return;
    setClearing(true);
    try {
      const r = await fetch("/api/alerts", { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error || "清空失败");
      toast.success("已清空");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-3xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold inline-flex items-center gap-2"><Bell size={16} /> 告警历史</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-muted-foreground">来源：</span>
            {(["", "host", "service", "test"] as const).map((s) => (
              <button
                key={s || "all"}
                className={`btn ${source === s ? "btn-primary" : "btn-outline"} !h-8 !px-3 !text-xs`}
                onClick={() => setSource(s)}
              >
                {s === "" ? "全部" : s === "host" ? "主机" : s === "service" ? "服务" : "测试"}
              </button>
            ))}
            <div className="flex-1" />
            <button className="btn btn-outline !h-8 !px-3 !text-xs" onClick={load}>刷新</button>
            <button
              className="btn btn-outline !h-8 !px-3 !text-xs text-destructive"
              onClick={clearAll}
              disabled={clearing || !events || events.length === 0}
            >
              <Trash size={12} /> 清空
            </button>
          </div>

          <div className="flex-1 overflow-auto -mx-1 px-1">
            {events === null ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无告警记录。</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {events.map((e) => (
                  <li key={e.id} className="py-2 flex items-start gap-3">
                    <span className={`dot mt-1.5 ${e.ok ? (e.kind.startsWith("recover") || e.kind === "up" || e.kind === "test" ? "dot-ok" : "dot-bad") : "dot-pending"}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{e.text}</span>
                        {!e.ok ? <span className="text-[10px] uppercase tracking-wide bg-destructive/10 text-destructive px-1.5 py-0.5 rounded">send failed</span> : null}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {new Date(e.at).toLocaleString()} · {e.source}/{e.kind}
                        {e.target_name ? ` · ${e.target_name}` : ""}
                        {e.error ? ` · ${e.error}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 分类区块 + 拖拽 -------------------- */

function CategorySection({
  containerId, title, items, onEdit, onDelete,
}: {
  containerId: string;
  title: string;
  items: Service[];
  onEdit: (s: Service) => void;
  onDelete: (id: number) => void;
}) {
  // 空容器用 useDroppable 保证能接收 drop；非空时 SortableContext 天然可接收
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`space-y-2 min-h-[3rem] rounded-lg transition-colors ${isOver ? "bg-muted/50 outline-dashed outline-1 outline-muted-foreground/30" : ""}`}
        >
          {items.length === 0 ? (
            <div className="card-surface p-6 text-center text-xs text-muted-foreground">
              {isOver ? "松手放入此分类" : "空 · 可将服务拖入此处"}
            </div>
          ) : (
            items.map((s) => (
              <SortableRow key={s.id} service={s} onEdit={() => onEdit(s)} onDelete={() => onDelete(s.id)} />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableRow({ service, onEdit, onDelete }: { service: Service; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: service.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="card-surface p-3 flex items-center gap-3">
      <button className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none" {...attributes} {...listeners} title="拖拽排序">
        <GripVertical size={16} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{service.name}</span>
          {service.is_private ? <span className="badge"><Lock size={10} /> 私有</span> : null}
        </div>
        <div className="text-xs text-muted-foreground truncate">{service.url}</div>
      </div>
      <button className="btn btn-ghost" onClick={onEdit}><Pencil size={14} /> 编辑</button>
      <button className="btn btn-ghost text-destructive" onClick={onDelete}><Trash2 size={14} /> 删除</button>
    </div>
  );
}

/* -------------------- 服务编辑对话框 -------------------- */

function ServiceDialog({
  initial, categories, onClose, onSaved,
}: {
  initial: Partial<Service>;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = typeof initial.id === "number";
  const [form, setForm] = useState<Partial<Service>>({
    name: "", url: "", icon: "Globe", description: "",
    internal_url: "", credentials: "", notes: "",
    is_private: 0, category_id: categories[0]?.id ?? null,
    check_type: "http", check_target: "",
    alerts_enabled: 1 as Service["alerts_enabled"],
    ...initial,
  });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof Service>(k: K, v: Service[K] | null | undefined) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        category_id: form.category_id ?? null,
        name: form.name?.trim(),
        url: form.url?.trim(),
        icon: form.icon || null,
        description: form.description || null,
        internal_url: form.internal_url || null,
        credentials: form.credentials || null,
        notes: form.notes || null,
        is_private: !!form.is_private,
        check_type: (form.check_type as Service["check_type"]) || "http",
        check_target: form.check_target || null,
        alerts_enabled: (form.alerts_enabled ?? 1) === 1,
      };
      const r = await fetch(isEdit ? `/api/services/${initial.id}` : "/api/services", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "保存失败");
      toast.success(isEdit ? "已更新" : "已创建");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-xl p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{isEdit ? "编辑服务" : "新增服务"}</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="label">名称 *</label>
              <input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="例：Portainer" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">访问 URL *</label>
              <input className="input" value={form.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://portainer.example.com" />
            </div>
            <div>
              <label className="label">分类</label>
              <select
                className="input"
                value={form.category_id ?? ""}
                onChange={(e) => set("category_id", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">未分类</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">图标</label>
              <select className="input" value={form.icon ?? "Globe"} onChange={(e) => set("icon", e.target.value)}>
                {ICON_CHOICES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">描述（公开可见）</label>
              <input className="input" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="一句话描述" />
            </div>

            <div className="sm:col-span-2 pt-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock size={12} /> 以下字段仅登录用户可见
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className="label">内网地址</label>
              <input className="input" value={form.internal_url ?? ""} onChange={(e) => set("internal_url", e.target.value)} placeholder="http://192.168.1.10:9000" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">凭据（多行，如账号/密码/API Key）</label>
              <textarea className="input" rows={3} value={form.credentials ?? ""} onChange={(e) => set("credentials", e.target.value)} placeholder={"user: admin\npass: ..."} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">备注 / 运维说明</label>
              <textarea className="input" rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="部署路径、启动命令、注意事项…" />
            </div>

            <div className="sm:col-span-2 flex items-center gap-2 pt-1">
              <input
                id="is_private" type="checkbox"
                checked={!!form.is_private}
                onChange={(e) => set("is_private", (e.target.checked ? 1 : 0) as Service["is_private"])}
              />
              <label htmlFor="is_private" className="text-sm">
                整条对公开访客隐藏（仅登录用户可见）
              </label>
            </div>

            <div className="sm:col-span-2 pt-3 border-t mt-1">
              <div className="text-xs text-muted-foreground mb-2">健康检查</div>
            </div>
            <div>
              <label className="label">检查方式</label>
              <select
                className="input"
                value={form.check_type ?? "http"}
                onChange={(e) => set("check_type", e.target.value as Service["check_type"])}
              >
                <option value="http">HTTP（默认，探测 URL 返回码）</option>
                <option value="tcp">TCP（探测 host:port，适合数据库/SSH/自定义协议）</option>
                <option value="none">不检查</option>
              </select>
            </div>
            <div>
              <label className="label">
                {form.check_type === "tcp" ? "目标 host:port（留空自动解析 URL）" : "目标 URL（留空用上面的访问 URL）"}
              </label>
              <input
                className="input"
                value={form.check_target ?? ""}
                onChange={(e) => set("check_target", e.target.value)}
                placeholder={
                  form.check_type === "tcp"
                    ? "192.168.1.10:3306"
                    : "https://service.example.com/healthz"
                }
                disabled={form.check_type === "none"}
              />
            </div>
            <div className="sm:col-span-2 flex items-center gap-2 pt-1">
              <input
                id="alerts_enabled" type="checkbox"
                checked={(form.alerts_enabled ?? 1) === 1}
                disabled={form.check_type === "none"}
                onChange={(e) => set("alerts_enabled", (e.target.checked ? 1 : 0) as Service["alerts_enabled"])}
              />
              <label htmlFor="alerts_enabled" className="text-sm">
                掉线时发送 Webhook 告警（仅当站点设置里配了 Webhook URL 才生效）
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button className="btn btn-outline" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !form.name || !form.url}>
              <Save size={14} /> {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------- 分类管理对话框 -------------------- */

function CategoryDialog({
  categories, onClose, onChanged,
}: {
  categories: Category[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [list, setList] = useState(categories);
  useEffect(() => setList(categories), [categories]);

  async function add() {
    if (!name.trim()) return;
    const r = await fetch("/api/categories", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (r.ok) { setName(""); onChanged(); const j = await r.json(); setList((l) => [...l, j.category]); toast.success("已添加"); }
    else toast.error("添加失败");
  }
  async function rename(c: Category, newName: string) {
    const r = await fetch(`/api/categories/${c.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (r.ok) { onChanged(); toast.success("已更新"); } else toast.error("更新失败");
  }
  async function del(c: Category) {
    if (!confirm(`删除分类 “${c.name}”？该分类下的服务会变为未分类。`)) return;
    const r = await fetch(`/api/categories/${c.id}`, { method: "DELETE" });
    if (r.ok) { setList((l) => l.filter((x) => x.id !== c.id)); onChanged(); toast.success("已删除"); }
    else toast.error("删除失败");
  }

  return (
    <>
      <div className="modal-mask" onClick={onClose} />
      <div className="modal-panel">
        <div className="card-surface w-full max-w-md p-5 sm:p-6 animate-fade-in max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">分类管理</h2>
            <button className="btn btn-ghost !h-8 !w-8 !p-0" onClick={onClose}><X size={16} /></button>
          </div>

          <div className="flex gap-2 mb-4">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="新分类名称" />
            <button className="btn btn-primary" onClick={add}><Plus size={14} /> 添加</button>
          </div>

          <div className="space-y-2">
            {list.map((c) => <CategoryRow key={c.id} cat={c} onRename={(n) => rename(c, n)} onDelete={() => del(c)} />)}
            {list.length === 0 ? <p className="text-xs text-muted-foreground text-center py-4">暂无分类</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}

function CategoryRow({ cat, onRename, onDelete }: { cat: Category; onRename: (n: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(cat.name);
  return (
    <div className="flex items-center gap-2 card-surface !p-2 px-3">
      <Globe size={14} className="text-muted-foreground" />
      {editing ? (
        <input className="input !h-8" value={v} onChange={(e) => setV(e.target.value)} autoFocus
               onKeyDown={(e) => { if (e.key === "Enter") { onRename(v); setEditing(false); } }} />
      ) : (
        <span className="flex-1 truncate">{cat.name}</span>
      )}
      {editing ? (
        <button className="btn btn-ghost" onClick={() => { onRename(v); setEditing(false); }}><Save size={14} /></button>
      ) : (
        <button className="btn btn-ghost" onClick={() => setEditing(true)}><Pencil size={14} /></button>
      )}
      <button className="btn btn-ghost text-destructive" onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}
