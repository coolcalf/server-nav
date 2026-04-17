# Server Hub · 自托管服务导航 + 健康监控 + 主机监控

一个轻量、现代、深浅自适应的自托管"服务首页"。一个站点囊括三件事：

1. **服务导航**（首页 `/`）：分类卡片，快速点开你的所有内网/外网服务。
2. **服务健康检查**：HTTP / TCP 探测，实时圆点 + 延迟趋势 sparkline + 浏览器 Tab 标题离线徽章 + 可选 Webhook 告警。
3. **主机资源监控**（`/hosts`）：抓取 Prometheus 兼容的 `node_exporter` / `windows_exporter`，可视化 CPU / 内存 / 负载 / 磁盘，超阈值自动告警。

技术栈：**Next.js 14 (App Router) + TypeScript + Tailwind + SQLite (better-sqlite3) + JWT (httpOnly cookie) + dnd-kit**。无外部依赖，单容器即可部署。

---

## 截图功能一览

| 模块 | 入口 | 说明 |
| --- | --- | --- |
| 服务首页 | `/` | 分类、搜索、卡片在线状态、延迟 sparkline |
| 主机监控 | `/hosts` | CPU / 内存 / 负载 / 磁盘 + sparkline + 阈值告警 |
| 管理后台 | `/admin` | 服务 CRUD、跨分类拖拽、批量导入、JSON 备份/恢复、改密、站点设置 |
| 登录 | `/login` | 单用户口令登录，JWT cookie |

---

## 本地开发

```bash
cp .env.example .env        # 改 ADMIN_PASSWORD 与 AUTH_SECRET
npm install
npm run dev
# 打开 http://localhost:3000
```

首次启动按 `.env` 创建管理员账号并插入一条示例服务。账号会被标记 **"必须修改密码"**，登录后管理页顶部会提示。

## 生产构建

```bash
npm run build
npm start
```

---

## Docker 部署（推荐）

仓库自带 `Dockerfile`（multi-stage、standalone 输出、SQLite 原生模块）+ `docker-compose.yml`，包含 **可选的 `node_exporter` sidecar**：

```bash
# 改一下 docker-compose.yml 里的密码与 AUTH_SECRET
docker compose up -d --build
# 浏览器打开 http://<服务器 IP>:3000
```

- 数据落 `./data/app.db`，可直接 `cp` 走备份。
- `node_exporter` 用 `network_mode: host`，跑起来后在面板里 **/hosts → 新增主机** 填 `http://<宿主机 IP>:9100/metrics` 即可监控宿主机。不需要它就把那段删掉。

### 反向代理（推荐 HTTPS）

随便用 Nginx / Caddy 反代到 `:3000`：

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

> 反代是 HTTPS、后端是 HTTP 时一切正常。代码在 `NODE_ENV=production` 自动给 cookie 加 `Secure`。

---

## Ubuntu + systemd 部署（不用 Docker）

```bash
git clone <your-repo> /opt/server-hub
cd /opt/server-hub
cp .env.example .env && vim .env       # 改密码 + AUTH_SECRET
npm ci
npm run build
```

`/etc/systemd/system/server-hub.service`：

```ini
[Unit]
Description=Server Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/server-hub
EnvironmentFile=/opt/server-hub/.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now server-hub
```

> 系统依赖：编译 `better-sqlite3` 需要 `apt install -y build-essential python3`。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 初次启动创建的管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 初始密码（请务必改） |
| `AUTH_SECRET` | _(必改)_ | JWT 签名密钥，`openssl rand -base64 48` 生成 |
| `DB_PATH` | `./data/app.db` | SQLite 文件位置 |
| `HEALTH_INTERVAL_MS` | `30000` | 服务巡检周期 |
| `HEALTH_TIMEOUT_MS` | `5000` | 单次服务探测超时 |
| `HOST_INTERVAL_MS` | `30000` | 主机巡检周期 |
| `HOST_TIMEOUT_MS` | `5000` | 单次 exporter 抓取超时 |
| `HOST_RETENTION_DAYS` | `7` | 主机历史采样在 SQLite 里保留天数 |
| `HOST_CONCURRENCY` | `8` | 每轮抓取 exporter 的并发上限 |
| `HEALTH_CONCURRENCY` | `16` | 每轮健康探测的并发上限 |
| `HOST_ALERT_SILENCE_MS` | _(设置里覆盖)_ | 主机告警静默（毫秒），未设且设置里也未填则 10 分钟 |
| `HEALTH_ALERT_SILENCE_MS` | _(设置里覆盖)_ | 服务告警静默（毫秒），同上 |
| `LOGIN_MAX_FAILS` | `5` | 登录失败多少次锁定 |
| `LOGIN_WINDOW_MS` | `900000` | 失败计数窗口（毫秒） |
| `LOGIN_LOCK_MS` | `900000` | 锁定时长（毫秒） |

---

## 服务（首页 `/`）

每张卡片字段：

| 字段 | 公开 | 说明 |
| --- | --- | --- |
| `name`, `url`, `icon`, `description`, `category` | ✅ | 卡片基础信息 |
| `internal_url` | ❌ | 内网地址/端口，登录后可见并可一键复制 |
| `credentials` | ❌ | 账号/密码/Key，登录后可显/隐/复制 |
| `notes` | ❌ | 运维备忘 |
| `is_private` | — | 勾选后整条卡片对公开访客不可见 |
| `check_type` | — | `http` / `tcp` / `none` |
| `check_target` | — | 检查目标，`http` 默认用 `url`，`tcp` 写 `host:port` |
| `alerts_enabled` | — | 该服务掉线是否触发 webhook |

### 健康检查与状态展示

- 服务端定时（默认 30s）统一探测，**不在浏览器侧**，避免 CORS / mixed-content 问题
- 卡片右上角：
  - 🟢 在线 + `123ms` 延迟
  - 🔴 掉线 + 错误原因（hover）
  - ⚪ 等待首次探测
  - 🚫 `check_type=none`：不检查
  - 旁边一条 64×16 的 SVG **延迟 sparkline**（保留最近 20 个采样，默认覆盖 10 分钟）
- 浏览器 **Tab 标题离线徽章**：有任何服务掉线时，标题前缀 `(🔴 N) ...`，方便后台 tab 一眼看到

### 搜索

- 顶部搜索框实时匹配 `name / url / description / check_target`，登录后还能匹配 `internal_url / notes`
- 右侧统计 `已显示 / 总数 · 在线 K`

### 管理（`/admin`）

- 新增 / 编辑 / 删除服务，分类管理
- **跨分类拖拽**：抓住服务前面的 `≡` 拖到任意分类（包括空分类）
- **批量导入 URL**：粘贴一堆 URL 一键建卡
  ```
  https://grafana.local:3000
  Grafana | https://grafana.local:3000
  Grafana | https://grafana.local:3000 | 监控
  ```
- **JSON 导出 / 导入**：完整备份和迁移（含 settings、分类、服务**和主机**，包括阈值、告警开关、Exporter 鉴权头等全部字段）。导入支持 `replace` / `merge` 两种模式；备份 JSON 中的 `credentials` 字段会**解密后**导出（明文，方便跨实例迁移）、导入时再加密落库
- **修改密码** + 默认密码风险提示
- **站点设置**：品牌名、标题、副标题、欢迎语（支持 `{{username}}` 占位）、**告警 Webhook URL** + 测试按钮、告警静默窗口（主机/服务各一）、告警历史保留天数
- **告警历史**：查看每一次真实推送，支持按来源筛选 / 清空

---

## 主机监控（`/hosts`）

通过 Prometheus 兼容 exporter 采集，**面板本身不需要在被监控机跑任何代码**。

### 在被监控机上装 exporter

**Linux/macOS：node_exporter**（默认 `:9100`）

裸装：
```bash
# 获取最新版本号
LATEST_VERSION=$(curl -s https://api.github.com/repos/prometheus/node_exporter/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

# 使用正确的版本号下载
wget "https://github.com/prometheus/node_exporter/releases/download/${LATEST_VERSION}/node_exporter-${LATEST_VERSION#v}.linux-amd64.tar.gz"

tar -xzf node_exporter-*.tar.gz
sudo mv node_exporter-*/node_exporter /usr/local/bin/

# 配 systemd 长期跑
sudo tee /etc/systemd/system/node_exporter.service >/dev/null <<'EOF'
[Unit]
Description=Prometheus node_exporter
After=network.target
[Service]
ExecStart=/usr/local/bin/node_exporter
Restart=always
User=nobody
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now node_exporter

# 允许 9100 端口
sudo ufw allow 9100/tcp
sudo ufw reload
```

或 docker 一行：
```bash
docker run -d --name node_exporter --restart=always \
  --net=host --pid=host -v "/:/host:ro,rslave" \
  prom/node-exporter:latest --path.rootfs=/host
```

**Windows：windows_exporter**（默认 `:9182`）

到 [windows_exporter Releases](https://github.com/prometheus-community/windows_exporter/releases) 下载 MSI 装上即可，会自动注册为服务。

### 在面板里添加主机

1. 顶部 **主机** → **新增主机**
2. 填名字、`http://192.168.1.10:9100/metrics`
3. 点 **测试连接** → 几秒内出 `✔ node · CPU 12% · 内存 47% · 磁盘 2 个`
4. 保存。卡片在 30s 内开始绘制 sparkline

### 阈值与告警

每台主机独立配置 `cpu_threshold / mem_threshold / disk_threshold`（默认都是 `90`）。

- 超阈值时卡片描边变橙色 + 该指标变橙
- 若全局 **告警 Webhook URL** 已配且该主机 `alerts_enabled = true`：连续 2 次失败/超阈值发送 `host_down / host_cpu / host_mem / host_disk`，恢复时发对应 `host_recover_*` / `host_up`
- 临时维护时可关闭某主机 `alerts_enabled` 静音

---

## Webhook 告警

`/admin → 站点设置 → 告警 Webhook`，留空则关闭。除 URL 外还可调：

- **主机告警静默（分钟）** / **服务告警静默（分钟）**：同一目标同种告警在静默窗口内只发一次，默认 10 分钟
- **告警历史保留（天）**：`alert_events` 表里超过该天数的记录自动裁剪，默认 30 天
- 工具栏 **告警历史** 可查看每一次真实推送（含发送失败原因）
- Webhook 输入框右侧 **测试** 按钮 → 立即发送一条 `kind=test` 消息验证连通性

触发条件（已经内置防抖）：

- 服务：连续 2 次失败 → `kind=down`；连续 2 次恢复 → `kind=up`
- 主机：连续 2 轮不可达或超阈值 → `kind=host_down/host_cpu/host_mem/host_disk`；对应恢复 → `host_up/host_recover_cpu/host_recover_mem/host_recover_disk`

### 统一 Payload（POST JSON）

项目**只发送一种 JSON 结构**，里面同时带了多个常见字段，方便直接接入 Discord / Slack / 自定义后端；飞书 / 企业微信因为 schema 特殊需要一层转发（见下文）。

```json
{
  "kind": "host_cpu",
  "host": { "id": 3, "name": "nas", "exporter_url": "http://10.0.0.5:9100/metrics" },
  "metrics": { "cpu_pct": 95.3, "mem_pct": 62.1, "load1": 4.1, "worst_disk_pct": 71.0 },
  "at": "2026-04-17T05:30:12.000Z",
  "text": "⚠️ nas CPU 95.3% 超阈值 90%",
  "content": "⚠️ nas CPU 95.3% 超阈值 90%",
  "msgtype": "text",
  "msg_type": "text",
  "text_content": "⚠️ nas CPU 95.3% 超阈值 90%"
}
```

服务告警会把 `host` 替换成 `service`：

```json
{
  "kind": "down",
  "service": { "id": 1, "name": "Grafana", "url": "https://grafana.local", "target": "https://grafana.local", "type": "http" },
  "latency": null, "status": null, "error": "timeout",
  "at": "...", "text": "🔴 Grafana 不可达（HTTP https://grafana.local）· timeout",
  "content": "...", "msgtype": "text", "msg_type": "text", "text_content": "..."
}
```

---

### Discord — 原生支持 ✅

1. 频道 **设置 → 整合 → Webhook → 新建 Webhook**（需要管理员权限）
2. 起个名字、选频道，点 **复制 Webhook URL**
3. 粘到 Server Hub 设置里，点 **测试**，频道立刻收到消息

Discord 读 `content` 字段，我们直接带了，零改造。URL 形如：

```
https://discord.com/api/webhooks/1234567890/xxxxxxxxxxxxxxxxxx
```

### Slack — Incoming Webhook ✅

1. 打开 <https://api.slack.com/apps> → **Create New App → From scratch**
2. 左栏 **Incoming Webhooks → Activate** → **Add New Webhook to Workspace**
3. 选一个频道授权，复制生成的 Webhook URL

Slack 读 `text` 字段，也是原生支持。URL 形如：

```
https://hooks.slack.com/services/TXXXXXXX/BXXXXXXX/xxxxxxxxxxxxxxxxxxxxxxxx
```

### webhook.site / 自定义后端 ✅

- **调试**：<https://webhook.site> 打开自动分配一个 URL，直接粘到设置里 → 点测试 → 页面上立刻看到整条 JSON
- **自定义**：任何能接收 `Content-Type: application/json` 的 POST 端点都可以，例如 n8n / Node-RED / Cloudflare Workers / 自写的 Express。根据 `kind`/`text` 做分流即可

### 飞书（Lark）自定义机器人 — 需要一层转发 ⚠️

飞书要求的 schema 是：

```json
{ "msg_type": "text", "content": { "text": "..." } }
```

而 Server Hub 发出的 `content` 是**字符串**，直接发会被飞书拒收。两种做法：

**1）群机器人**：群设置 → **群机器人 → 添加机器人 → 自定义机器人**，复制 URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx`）。然后**不要直接**把 URL 填到 Server Hub；把它配到下面任一转发器：

**2）Cloudflare Workers 转发器**（最快，5 分钟部署、免费）：

```js
// 部署后用 Workers URL 替代原 webhook URL 填进 Server Hub
const LARK = "https://open.feishu.cn/open-apis/bot/v2/hook/替换为你的token";
export default {
  async fetch(req) {
    const body = await req.json();
    const text = body.text || body.content || JSON.stringify(body);
    return fetch(LARK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
  },
};
```

**安全校验（可选）**：如果机器人开了"签名校验"，Workers 里需要用 `HMAC-SHA256(timestamp + "\n" + secret, "")` 拼出签名（飞书官方文档有示例），把 `timestamp / sign` 一起 POST 过去。

### 企业微信（WeCom）群机器人 — 需要一层转发 ⚠️

企业微信要求：

```json
{ "msgtype": "text", "text": { "content": "..." } }
```

`text` 是对象，我们发的是字符串，同样需要转发器。群设置 → **群机器人 → 添加机器人**，拿到形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` 的 URL。转发器和飞书那个几乎一样：

```js
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=替换为你的key";
export default {
  async fetch(req) {
    const body = await req.json();
    const text = body.text || body.content || JSON.stringify(body);
    return fetch(WECOM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
  },
};
```

> 不想写 Workers？用 n8n / Node-RED 拖一个 "Webhook → Function → HTTP Request" 流程也是 3 分钟的事。

### 钉钉 / Telegram 等其它平台

同上思路：拿一个 Cloudflare Workers / 任意后端做字段重映射即可。只要你的转发器接收 `text` 字段、把它塞到对方要求的字段里就行。

---

## 目录结构

```
src/
  app/
    page.tsx               # 公开服务首页
    hosts/page.tsx         # 主机监控页
    login/page.tsx         # 登录
    admin/                 # 管理后台
    api/
      auth/                # login / logout / me / change-password
      services/            # CRUD + reorder + bulk
      categories/          # CRUD
      settings/            # 站点设置
      health/              # 单次探测 / 全量状态 (statuses)
      hosts/               # CRUD + metrics + probe
      backup/              # export / import
  components/
    nav-bar.tsx, theme-toggle.tsx, accent-picker.tsx
    service-card.tsx, home-browser.tsx
    hosts-browser.tsx
    sparkline.tsx
  lib/
    db.ts                  # SQLite 初始化 + 迁移 + seed
    auth.ts                # JWT cookie
    health-monitor.ts      # 服务巡检 + 历史 + 告警
    host-monitor.ts        # 主机巡检 + 历史 + 告警
    prom-parser.ts         # Prometheus 文本解析
    types.ts
data/app.db                # SQLite 数据
```

---

## 常见问题

**忘记密码？**
停掉服务 → 删 `data/app.db` 里的 `users` 表（或整个文件）→ 重启时按 `.env` 重建。

**HTTP 反代下 cookie 不工作？**
代码只在 `NODE_ENV=production` 加 `Secure`。生产请务必走 HTTPS（反代终结即可）。

**`better-sqlite3` 安装失败？**
Linux 需要 `apt install -y build-essential python3`；Docker 已内置。

**Windows 主机的 CPU 始终是 0 / 异常？**
首次抓取没有差值，需要等第二轮（`HOST_INTERVAL_MS` 默认 30s）。"测试连接"按钮内置等待并连抓两次。

**抓取不到磁盘？**
- node_exporter 默认排除了 tmpfs/proc/sys 等伪文件系统，本项目又叠加了一层过滤
- 容器里跑 node_exporter 想看到宿主机磁盘，必须挂 `/:/host:ro,rslave` 并加 `--path.rootfs=/host`（compose 里已经这么写了）

**首次启动密码警告条**
首个种子用户有 `must_change_password = 1` 标记，登录后管理页顶部会显示橙色提示，点 **立即修改** 即可清除。

---

## 安全提示

- **务必修改** `.env` 里的 `ADMIN_PASSWORD`、`AUTH_SECRET`
- 公开互联网暴露请走 HTTPS（Cloudflare、Nginx + Let's Encrypt、Caddy 任选）
- 凭据字段 `credentials` 在数据库中使用 **AES-256-GCM 加密**（密钥由 `AUTH_SECRET` 派生，首次启动会自动把已有明文加密升级）。注意：**`AUTH_SECRET` 丢失将无法解密旧 credentials**，请务必备份。SQLite 文件仍建议 `chmod 600 data/app.db`
- 登录接口内置速率限制：同一 `IP + username` 连续 `LOGIN_MAX_FAILS` 次错密码会锁定 `LOGIN_LOCK_MS` 毫秒（默认 5 次 / 15 分钟），返回 `429`
- 主机的 `auth_header` 字段只在已登录状态下返回；未登录的公开 API 响应会剥掉它

---

## 路线图（社区任意提）

- [x] 服务 + 健康检查 + sparkline + tab 徽章
- [x] 跨分类拖拽 / 批量导入 / JSON 备份
- [x] 修改密码 + 默认口令提示
- [x] 主机监控（node / windows exporter）+ 阈值告警
- [x] Docker compose with node_exporter sidecar
- [x] 主机详情页（1h / 6h / 24h / 7d 大图，带 hover 游标）
- [x] 主机历史持久化到 SQLite + 按区间聚合
- [ ] 多用户 + 角色（admin / viewer）
- [ ] 飞书 / 企业微信原生卡片格式
- [ ] PWA + 移动端图标

PR / Issue 欢迎。
