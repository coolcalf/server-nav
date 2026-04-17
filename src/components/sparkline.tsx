"use client";

/**
 * 迷你延迟折线：
 * - 数据点为 number（ms）或 null（掉线）
 * - null 段用独立红色 "dash" 标记
 * - 无依赖，纯 SVG，足够轻量
 */
export function Sparkline({
  data,
  width = 80,
  height = 20,
  className = "",
}: {
  data: (number | null)[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeOpacity="0.2" strokeDasharray="2 3" />
      </svg>
    );
  }

  const okValues = data.filter((v): v is number => typeof v === "number");
  const max = okValues.length ? Math.max(...okValues, 1) : 1;
  const min = okValues.length ? Math.min(...okValues, 0) : 0;
  const range = Math.max(1, max - min);

  const n = data.length;
  const stepX = n > 1 ? width / (n - 1) : width;

  const y = (v: number) => {
    const pad = 2;
    const h = height - pad * 2;
    return pad + h - ((v - min) / range) * h;
  };

  // 为 null 值生成"断线"：只连接相邻的非 null 段
  const segments: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  data.forEach((v, i) => {
    if (typeof v === "number") {
      cur.push({ x: i * stepX, y: y(v) });
    } else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length) segments.push(cur);

  // 标记 null 点为红色短竖线
  const downMarks = data
    .map((v, i) => (v === null ? i : -1))
    .filter((i) => i >= 0);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {segments.map((pts, i) => (
        <polyline
          key={i}
          points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {downMarks.map((i) => (
        <line
          key={`d-${i}`}
          x1={i * stepX}
          y1={2}
          x2={i * stepX}
          y2={height - 2}
          stroke="rgb(239 68 68 / 0.75)"
          strokeWidth="1.25"
        />
      ))}
    </svg>
  );
}
