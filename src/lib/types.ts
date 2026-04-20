export type Category = {
  id: number;
  name: string;
  sort_order: number;
};

export type Service = {
  id: number;
  category_id: number | null;
  name: string;
  url: string;
  icon: string | null;
  description: string | null;
  /** 仅登录可见字段 */
  internal_url: string | null;
  credentials: string | null;
  notes: string | null;
  /** 整条对公开访客隐藏 */
  is_private: 0 | 1;
  /** 健康检查方式 */
  check_type: "http" | "tcp" | "none";
  /** 检查目标：http 时为 URL（不填用 url 字段），tcp 时为 host:port（不填从 url 推导） */
  check_target: string | null;
  /** 该服务掉线时是否触发 webhook 告警 */
  alerts_enabled: 0 | 1;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** 发给公开访客的精简对象 */
export type PublicService = Omit<
  Service,
  "internal_url" | "credentials" | "notes" | "is_private"
>;

export type HostGroup = {
  id: number;
  name: string;
  sort_order: number;
};

export type Host = {
  id: number;
  group_id: number | null;
  name: string;
  exporter_url: string;
  /** 'auto' | 'node' | 'windows' */
  exporter_type: "auto" | "node" | "windows";
  enabled: 0 | 1;
  is_private: 0 | 1;
  alerts_enabled: 0 | 1;
  cpu_threshold: number;
  mem_threshold: number;
  disk_threshold: number;
  description: string | null;
  /** 可选：抓取 exporter 时附加的 Authorization header，例如 "Bearer xxx" 或 "Basic base64..."。不填则不带 */
  auth_header: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ApiToken = {
  id: number;
  user_id: number;
  token_hash: string;
  name: string;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: string;
};

export type UserHostAccess = {
  id: number;
  user_id: number;
  host_id: number | null;
  group_id: number | null;
  created_at: string;
};

export type HostMetrics = {
  ok: boolean;
  error?: string;
  scrapedAt: number;
  /** 0~100 */
  cpu_pct: number | null;
  mem_pct: number | null;
  mem_used_bytes?: number;
  mem_total_bytes?: number;
  load1: number | null;
  uptime_seconds?: number;
  /** 所有非虚拟网卡合计接收 / 发送速率（bytes per second），首次采样为 null */
  rx_bps?: number | null;
  tx_bps?: number | null;
  disks: Array<{
    mount: string;
    fstype?: string;
    used_pct: number;
    used_bytes: number;
    total_bytes: number;
  }>;
  /** 检测到的 exporter 类型（从指标名前缀推断） */
  flavor?: "node" | "windows";
};

export type HostHistoryPoint = {
  at: number;
  cpu: number | null;
  mem: number | null;
};
