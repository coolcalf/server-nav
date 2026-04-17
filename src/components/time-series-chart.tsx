"use client";
import { useMemo, useState } from "react";

export type Series = {
  name: string;
  color: string;
  data: Array<{ at: number; v: number | null }>;
};

export function TimeSeriesChart({
  series,
  height = 180,
  yMin,
  yMax,
  yUnit = "",
  yTicks = [0, 25, 50, 75, 100],
  title,
}: {
  series: Series[];
  height?: number;
  /** 如果不给，根据数据自动；给了就固定（如 0-100） */
  yMin?: number;
  yMax?: number;
  yUnit?: string;
  yTicks?: number[];
  title?: string;
}) {
  const [hover, setHover] = useState<number | null>(null); // index into combined timeline

  // 合并时间轴（并集），并为每条 series 做一个按 at -> v 的索引
  const { times, columns, min, max } = useMemo(() => {
    const tset = new Set<number>();
    for (const s of series) for (const p of s.data) tset.add(p.at);
    const times = Array.from(tset).sort((a, b) => a - b);
    const columns = series.map((s) => {
      const m = new Map(s.data.map((p) => [p.at, p.v]));
      return times.map((t) => m.get(t) ?? null);
    });
    let autoMin = yMin ?? Infinity;
    let autoMax = yMax ?? -Infinity;
    if (yMin == null || yMax == null) {
      for (const col of columns) for (const v of col) if (v != null && Number.isFinite(v)) {
        if (yMin == null && v < autoMin) autoMin = v;
        if (yMax == null && v > autoMax) autoMax = v;
      }
      if (!Number.isFinite(autoMin)) autoMin = 0;
      if (!Number.isFinite(autoMax)) autoMax = 1;
      if (autoMin === autoMax) autoMax = autoMin + 1;
    }
    return { times, columns, min: autoMin, max: autoMax };
  }, [series, yMin, yMax]);

  const W = 800;
  const H = height;
  const padL = 40, padR = 12, padT = 12, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const n = times.length;
  const xOf = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yOf = (v: number) => {
    const pct = (v - min) / (max - min);
    return padT + innerH - pct * innerH;
  };

  function pathFor(col: (number | null)[]): string {
    const parts: string[] = [];
    let pen = false;
    col.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      const cmd = pen ? "L" : "M";
      parts.push(`${cmd}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`);
      pen = true;
    });
    return parts.join(" ");
  }

  const ticks = useMemo(() => {
    // filter yTicks within [min,max] or always show given set if yMin/yMax fixed
    if (yMin != null && yMax != null) return yTicks.filter((t) => t >= yMin && t <= yMax);
    // 自动模式：生成 4 个均匀刻度
    const arr: number[] = [];
    for (let i = 0; i <= 4; i++) arr.push(min + ((max - min) * i) / 4);
    return arr;
  }, [yTicks, min, max, yMin, yMax]);

  function fmtTick(v: number): string {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const rel = Math.max(0, Math.min(innerW, x - padL));
    const i = Math.round((rel / innerW) * (n - 1));
    setHover(i);
  }

  function xLabel(t: number): string {
    const d = new Date(t);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  return (
    <div className="card-surface p-3 sm:p-4">
      <div className="flex items-center gap-4 mb-2">
        {title ? <div className="text-xs font-medium text-muted-foreground">{title}</div> : null}
        <div className="flex items-center gap-3 text-[11px]">
          {series.map((s) => (
            <div key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
              <span>{s.name}</span>
            </div>
          ))}
        </div>
        <div className="flex-1" />
        {hover != null && times[hover] != null ? (
          <div className="text-[11px] text-muted-foreground">
            {xLabel(times[hover])} ·{" "}
            {series.map((s, si) => {
              const v = columns[si][hover];
              return (
                <span key={s.name} style={{ color: s.color }} className="ml-2">
                  {s.name}: {v == null ? "—" : `${fmtTick(v)}${yUnit}`}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      {n === 0 ? (
        <div className="text-xs text-muted-foreground py-16 text-center">暂无数据（需要等后台采样几轮）</div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          className="block"
        >
          {/* 网格 */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} y1={yOf(t)} x2={W - padR} y2={yOf(t)} stroke="currentColor" strokeOpacity="0.08" />
              <text x={padL - 4} y={yOf(t) + 3} fontSize="9" textAnchor="end" fill="currentColor" fillOpacity="0.55">
                {fmtTick(t)}{yUnit}
              </text>
            </g>
          ))}

          {/* X 轴刻度：起 / 中 / 末 */}
          {[0, Math.floor((n - 1) / 2), n - 1].filter((i, k, arr) => arr.indexOf(i) === k && i >= 0).map((i) => (
            <text key={i} x={xOf(i)} y={H - 6} fontSize="9" textAnchor="middle" fill="currentColor" fillOpacity="0.55">
              {xLabel(times[i])}
            </text>
          ))}

          {/* 各条曲线 */}
          {series.map((s, si) => (
            <path
              key={s.name}
              d={pathFor(columns[si])}
              fill="none"
              stroke={s.color}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.95"
            />
          ))}

          {/* hover cursor */}
          {hover != null && times[hover] != null ? (
            <>
              <line
                x1={xOf(hover)} y1={padT} x2={xOf(hover)} y2={H - padB}
                stroke="currentColor" strokeOpacity="0.35" strokeDasharray="3 3"
              />
              {series.map((s, si) => {
                const v = columns[si][hover];
                if (v == null) return null;
                return (
                  <circle
                    key={s.name}
                    cx={xOf(hover)} cy={yOf(v)} r="2.5"
                    fill={s.color}
                    stroke="var(--background, #fff)" strokeWidth="1"
                  />
                );
              })}
            </>
          ) : null}
        </svg>
      )}
    </div>
  );
}
