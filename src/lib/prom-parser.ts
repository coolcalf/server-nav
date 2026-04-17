/**
 * 极简 Prometheus 文本格式解析器（够用即可）。
 * 支持：name, name{labels}, 浮点值（含 NaN/Inf 容错），跳过注释。
 * 不解析 # HELP / # TYPE 元数据；不解析 timestamp。
 */

export type Sample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function unquote(s: string): string {
  return s.replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
}

export function parseProm(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, name, labelsRaw, valueStr] = m;
    const valueToken = valueStr.split(/\s+/)[0];
    let value: number;
    if (valueToken === "NaN") value = NaN;
    else if (valueToken === "+Inf" || valueToken === "Inf") value = Infinity;
    else if (valueToken === "-Inf") value = -Infinity;
    else value = Number(valueToken);
    if (Number.isNaN(value)) continue;
    const labels: Record<string, string> = {};
    if (labelsRaw) {
      const inside = labelsRaw.slice(1, -1);
      LABEL_RE.lastIndex = 0;
      let lm: RegExpExecArray | null;
      while ((lm = LABEL_RE.exec(inside))) {
        labels[lm[1]] = unquote(lm[2]);
      }
    }
    out.push({ name, labels, value });
  }
  return out;
}

/** 找出所有同名指标 */
export function getAll(samples: Sample[], name: string): Sample[] {
  return samples.filter((s) => s.name === name);
}

/** 取第一个匹配指标的 value，没有则 null */
export function getOne(samples: Sample[], name: string): number | null {
  const s = samples.find((x) => x.name === name);
  return s ? s.value : null;
}

/** 求和某个指标（可选 labels 过滤） */
export function sumWhere(
  samples: Sample[],
  name: string,
  filter?: (l: Record<string, string>) => boolean,
): number {
  let s = 0;
  for (const x of samples) {
    if (x.name !== name) continue;
    if (filter && !filter(x.labels)) continue;
    s += x.value;
  }
  return s;
}
