# Server Nav · 自托管服务导航 + 健康监控 + 主机监控

一个轻量、现代、深浅自适应的自托管"服务首页"。一个站点囊括五件事：

1. **服务导航**（首页 `/`）：分类卡片，快速点开你的所有内网/外网服务。
2. **服务健康检查**：HTTP / TCP 探测，实时圆点 + 延迟趋势 sparkline + 浏览器 Tab 标题离线徽章 + 可选 Webhook 告警。
3. **主机资源监控**（`/hosts`）：抓取 Prometheus 兼容的 `node_exporter` / `windows_exporter`，可视化 CPU / 内存 / 负载 / 磁盘 / 网络吞吐，超阈值自动告警。
4. **多用户与移动端 API**：admin / viewer 两种角色，独立的 Bearer Token 认证，按用户粒度控制主机可见范围。
5. **联邦模式（多站点聚合）**：公网设一套主控端，各局域网实例作为节点自动推送数据，一个页面监控所有站点，无需 VPN。

技术栈：**Next.js 14 (App Router) + TypeScript + Tailwind + SQLite (better-sqlite3) + JWT (httpOnly cookie) + dnd-kit**。无外部依赖，单容器即可部署。

---

## 功能一览

| 模块 | 入口 | 说明 |
| --- | --- | --- |
| 服务首页 | `/` | 分类卡片、搜索、在线状态圆点、延迟 sparkline |
| 主机监控 | `/hosts` | CPU / 内存 / 负载 / 磁盘 / 网络 + sparkline + 分组 + 拖拽排序 |
| 主机详情 | `/hosts/:id` | 1h / 6h / 24h / 7d 大图曲线，hover 游标 |
| 管理后台 | `/admin` | 服务 CRUD、跨分类拖拽、批量导入、JSON 备份/恢复、站点设置 |
| 用户管理 | `/admin` → 用户 | 多用户 CRUD、角色切换、Token 管理、主机权限分配 |
| 联邦管理 | `/admin` → 联邦 | 注册远程节点、查看在线状态、停用/删除、公开可见控制 |
| 登录 | `/login` | 用户名/密码登录，JWT httpOnly cookie，30 天有效 |
| 移动端 API | `/api/mobile/*` | Bearer Token 认证，按用户权限过滤主机数据 |
| 主题定制 | 导航栏 | 深色/浅色切换 + 6 种配色主题（石墨/蓝/翠绿/玫红/紫罗兰/琥珀） |

---

## 快速开始

### 本地开发

```bash
cp .env.example .env        # 改 ADMIN_PASSWORD 与 AUTH_SECRET
npm install
npm run dev
# 打开 http://localhost:3000
```

首次启动按 `.env` 创建管理员账号并插入一条示例服务。账号会被标记 **"必须修改密码"**，登录后管理页顶部会提示。

### 生产构建

```bash
npm run build
npm start
```

---

## Docker 部署（推荐）

仓库自带 `Dockerfile`（multi-stage、standalone 输出、SQLite 原生模块）+ `docker-compose.yml`，包含 **可选的 `node_exporter` sidecar**：

```bash
# 先准备环境变量
cp .env.example .env
# 改 ADMIN_PASSWORD / AUTH_SECRET；如果要换对外端口，改 HOST_PORT；必要时把 INSTALL_BUILD_DEPS 改成 true
# 直接 HTTP 访问时保持 COOKIE_SECURE=false；放到 HTTPS 反代后改成 true
vim .env
docker compose up -d --build
# 浏览器打开 http://<服务器 IP>:HOST_PORT
```

- 默认使用 Docker named volume `server_nav_data` 持久化数据库，避免宿主机目录权限导致 SQLite 无法写入。
- 如果你想把数据库直接落到宿主机目录，使用 `docker-compose.bind.yml` 覆盖默认 volume：`docker compose -f docker-compose.yml -f docker-compose.bind.yml up -d --build`。
- `node_exporter` 默认归为 `monitoring` profile，不会随主服务一起启动。需要时用 `docker compose --profile monitoring up -d` 启用，跑起来后在面板里 **/hosts → 新增主机** 填 `http://<宿主机 IP>:9100/metrics` 即可监控宿主机。
- 默认使用 `better-sqlite3` 的预编译二进制，构建通常不需要额外系统依赖。

### Docker 数据备份

默认部署使用 named volume 时，可以这样把数据库导出到当前目录：

```bash
docker run --rm -v server_nav_data:/from -v "$PWD":/to alpine sh -c 'cp /from/app.db /to/app.db'
```

如果你启用了 `docker-compose.bind.yml`，数据库默认就在宿主机 `./data/app.db`。

### Docker 构建慢或失败时

先看详细构建日志：

```bash
docker compose build --progress=plain
```

如果失败点在 `better-sqlite3`，通常是当前机器架构或网络导致拿不到预编译包。此时把 `.env` 里的 `INSTALL_BUILD_DEPS=true`，再重新构建：

```bash
docker compose build --no-cache
docker compose up -d
```

常见触发场景：

- `arm64` / `aarch64` 机器
- 服务器访问 npm 预编译资源不稳定
- 某些代理/防火墙拦截二进制下载

### 反向代理（推荐 HTTPS）

随便用 Nginx / Caddy 反代到 `:3000`：

```nginx
server {
    listen 80;
    # server_name nav.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

> 反代是 HTTPS、后端是 HTTP 时一切正常。此时请把 `.env` 里的 `COOKIE_SECURE=true`，让登录 cookie 带上 `Secure`。

---

## Ubuntu + systemd 部署（不用 Docker）

```bash
git clone <your-repo> /opt/server-nav
cd /opt/server-nav
cp .env.example .env && vim .env       # 改密码 + AUTH_SECRET
npm ci
npm run build
```

`/etc/systemd/system/server-nav.service`：

```ini
[Unit]
Description=Server Nav
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/server-nav
EnvironmentFile=/opt/server-nav/.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 8080
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now server-nav
```

> 系统依赖：编译 `better-sqlite3` 需要 `apt install -y build-essential python3`。Docker 默认优先走预编译二进制；只有拿不到预编译包时，才需要把 `.env` 里的 `INSTALL_BUILD_DEPS` 改成 `true` 后重建。

---

## 环境变量

### 基础配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 初次启动创建的管理员用户名 |
| `ADMIN_PASSWORD` | `change-me-please` | 初始密码（**请务必修改**） |
| `AUTH_SECRET` | _(必改)_ | JWT 签名密钥 + 字段加密密钥派生源，`openssl rand -base64 48` 生成 |
| `COOKIE_SECURE` | `false` | 是否给登录 cookie 加 `Secure`；直接 HTTP 访问用 `false`，HTTPS 反代后改为 `true` |
| `DB_PATH` | `/data/app.db` | SQLite 文件位置（Docker 默认） |
| `HOST_PORT` | `3000` | Docker 宿主机暴露端口（容器内固定监听 3000） |
| `DISABLE_WEB_UI` | `false` | 设为 `true` 后隐藏所有 Web 页面（`/`、`/login`、`/admin`、`/hosts`），仅保留 `/api/*` 端点，适合纯 API 模式 |

### 服务巡检

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HEALTH_INTERVAL_MS` | `30000` | 服务巡检周期（毫秒） |
| `HEALTH_TIMEOUT_MS` | `5000` | 单次 HTTP/TCP 探测超时 |
| `HEALTH_CONCURRENCY` | `16` | 每轮健康探测的并发上限 |
| `HEALTH_ALERT_SILENCE_MS` | _(设置里覆盖)_ | 服务告警静默（毫秒），数据库设置优先，否则默认 10 分钟 |

### 主机巡检

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST_INTERVAL_MS` | `30000` | 主机巡检周期（毫秒） |
| `HOST_TIMEOUT_MS` | `5000` | 单次 exporter 抓取超时 |
| `HOST_CONCURRENCY` | `8` | 每轮抓取 exporter 的并发上限 |
| `HOST_RETENTION_DAYS` | `7` | 主机历史采样在 SQLite 里保留天数 |
| `HOST_ALERT_SILENCE_MS` | _(设置里覆盖)_ | 主机告警静默（毫秒），数据库设置优先，否则默认 10 分钟 |

### 安全 / 速率限制

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOGIN_MAX_FAILS` | `5` | 同一 `IP+用户名` 登录失败多少次后锁定 |
| `LOGIN_WINDOW_MS` | `900000` | 失败计数窗口（毫秒，默认 15 分钟） |
| `LOGIN_LOCK_MS` | `900000` | 锁定时长（毫秒，默认 15 分钟） |
| `GLOBAL_IP_MAX_REQUESTS` | `30` | 同一 IP 在窗口期内对认证端点的最大请求数 |
| `GLOBAL_IP_WINDOW_MS` | `60000` | 全局 IP 限速窗口（毫秒，默认 60 秒） |

### 联邦模式

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEDERATION_MODE` | `standalone` | 运行模式：`standalone` / `master` / `agent` |
| `MASTER_URL` | — | (agent) 主控端 URL，如 `https://nav.example.com` |
| `AGENT_KEY` | — | (agent) 主控端分配的 API 密钥 |
| `AGENT_NAME` | _(主机名)_ | (agent) 本节点显示名称 |
| `AGENT_PUSH_INTERVAL_MS` | `30000` | (agent) 推送间隔（毫秒） |

### Docker 构建专用

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `INSTALL_BUILD_DEPS` | `false` | 设为 `true` 在 Docker 构建时安装编译链（`python3`、`make`、`g++`），用于 `better-sqlite3` 预编译包不可用的场景 |

---

## 联邦模式（多站点聚合监控）

当你的 Server Nav 部署在多个企业/分支局域网内，可以在公网架设一套 **主控端 (master)**，各局域网实例作为 **节点 (agent)** 实时推送数据，在主控端统一查看所有站点的服务与主机状态——无需逐个 VPN。

### 部署步骤

**1. 公网主控端**

```bash
# .env
FEDERATION_MODE=master
```

启动后进入 **管理 → 联邦**，为每个远程站点创建节点，系统会生成一个 **一次性密钥**（`sn_...`），请立即保存。

**2. 局域网节点**

```bash
# .env
FEDERATION_MODE=agent
MASTER_URL=https://公网主控端地址
AGENT_KEY=sn_刚才保存的密钥
AGENT_NAME=广州分公司
AGENT_PUSH_INTERVAL_MS=30000
```

节点启动后会按 `AGENT_PUSH_INTERVAL_MS` 间隔，将本地所有主机指标和服务健康状态推送到主控端。

### 主控端效果

- **首页 `/`**：本地服务之后，按节点分组展示各远程站点的服务卡片 + 健康状态
- **主机 `/hosts`**：本地主机之后，按节点分组展示各远程站点的主机 CPU / 内存 / 磁盘等指标
- **管理 → 联邦**：查看所有节点的在线状态、上次报到时间，支持停用/删除节点

### 安全说明

- 节点推送时使用 `AGENT_KEY` + bcrypt 校验身份，密钥仅在创建时显示一次
- 节点推送的数据会自动脱敏：不包含 `credentials`、`notes`、`internal_url`、`auth_header` 等敏感字段
- 推送走 HTTPS（建议主控端启用反代 + SSL）

---

## 服务（首页 `/`）

每张卡片字段：

| 字段 | 公开 | 说明 |
| --- | --- | --- |
| `name`, `url`, `icon`, `description`, `category` | ✅ | 卡片基础信息（icon 使用 [Lucide](https://lucide.dev/) 图标名） |
| `internal_url` | ❌ | 内网地址/端口，登录后可见并可一键复制 |
| `credentials` | ❌ | 账号/密码/Key（AES-256-GCM 加密存储），登录后可显/隐/复制 |
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
- HTTP 探测返回 `< 500` 均视为在线（含 3xx/4xx），`≥ 500` 视为故障
- TCP 探测支持自动从 URL 推导 `host:port`（识别 `http/https/mysql/postgres/redis/mongodb/ssh/ftp` 等协议默认端口）

### 搜索

- 顶部搜索框实时匹配 `name / url / description / check_target`，登录后还能匹配 `internal_url / notes`
- 右侧统计 `已显示 / 总数 · 在线 K`

### 管理（`/admin`）

- 新增 / 编辑 / 删除服务，分类管理
- **跨分类拖拽**：抓住服务前面的 `≡` 拖到任意分类（包括空分类）
- **批量导入 URL**：粘贴一堆 URL 一键建卡
  ```
  https://grafana.local:8080
  Grafana | https://grafana.local:8080
  Grafana | https://grafana.local:8080 | 监控
  ```
- **JSON 导出 / 导入**：完整备份和迁移（含 settings、分类、服务**和主机**，包括阈值、告警开关、Exporter 鉴权头等全部字段）。导入支持 `replace` / `merge` 两种模式；备份 JSON 中的 `credentials` 字段会**解密后**导出（明文，方便跨实例迁移）、导入时再加密落库
- **修改密码** + 默认密码风险提示
- **站点设置**：品牌名、标题、副标题、欢迎语（支持 `{{username}}` 占位）、**告警 Webhook URL** + 测试按钮、告警静默窗口（主机/服务各一）、告警历史保留天数
- **告警历史**：查看每一次真实推送，支持按来源筛选 / 清空

### 多用户管理（`/admin` → 用户）

- **创建用户**：指定用户名（`字母/数字/下划线/点/中横线`，2~40 字符）、密码（≥ 6 位）、角色（admin / viewer）
- **角色切换**：admin 可以把用户在 admin / viewer 间切换；不允许把最后一个 admin 降级
- **删除用户**：级联删除其 API Token 和主机权限配置；不能删除自己，不能删除最后一个 admin
- **主机权限管理**：点击用户名进入详情面板，可按**单台主机**或**主机分组**授权 viewer 可见范围
- **Token 管理**：查看用户已有的 API Token（设备名、最后使用时间、过期时间），可逐条吊销

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
sudo ufw allow 9100/tcp && sudo ufw reload
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
3. 可选：选择所属**主机分组**、填写描述、配置 Exporter 鉴权头（`Bearer xxx` 或 `Basic base64...`）
4. 点 **测试连接** → 几秒内出 `✔ node · CPU 12% · 内存 47% · 磁盘 2 个`
5. 保存。卡片在 30s 内开始绘制 sparkline

### 主机分组与排序

- **管理 → 主机分组**：创建/编辑/删除分组
- 主机卡片支持**跨分组拖拽排序**（登录后可见拖拽手柄），基于 dnd-kit 实现
- 空分组也会显示为可放置目标

### 采集指标

| 指标 | node_exporter | windows_exporter |
| --- | --- | --- |
| CPU 使用率 | ✅ 差值计算 | ✅ 差值计算 |
| 内存使用率 | ✅ MemAvailable 优先 | ✅ physical_memory |
| 系统负载 | ✅ load1 | — |
| 磁盘使用率 | ✅ 按挂载点，过滤伪 FS | ✅ 按卷，过滤 _Total |
| 网络吞吐 | ✅ rx/tx Bps，过滤虚拟网卡 | ✅ rx/tx Bps，过滤虚拟 NIC |
| 在线时长 | ✅ boot_time 推算 | — |

- **Exporter 类型**：默认 `auto`（自动从指标名前缀推断），也可手动指定 `node` 或 `windows`
- **主机详情页**（`/hosts/:id`）：1h / 6h / 24h / 7d 时间范围的大图曲线，hover 显示游标值，数据从 SQLite 持久化采样聚合而来

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
3. 粘到 Server Nav 设置里，点 **测试**，频道立刻收到消息

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

而 Server Nav 发出的 `content` 是**字符串**，直接发会被飞书拒收。两种做法：

**1）群机器人**：群设置 → **群机器人 → 添加机器人 → 自定义机器人**，复制 URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx`）。然后**不要直接**把 URL 填到 Server Nav；把它配到下面任一转发器：

**2）Cloudflare Workers 转发器**（最快，5 分钟部署、免费）：

```js
// 部署后用 Workers URL 替代原 webhook URL 填进 Server Nav
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

## 移动端 API

为移动端 App 提供独立的 **Bearer Token 认证** + **按用户粒度的主机访问权限控制**，与 Web 端的 cookie 会话互不干扰。

### 认证方式

移动端使用 **API Token**（前缀 `snav_`），通过 `Authorization: Bearer <token>` 请求头传递。Token 在登录时签发，默认 90 天有效，可随时吊销。

### 权限模型

| 角色 | 可见范围 |
| --- | --- |
| `admin` | 全部主机 |
| `viewer` | 仅管理员显式授权的主机或主机分组 |

管理员通过 `/api/users/:id/host-access` 管理每个 viewer 用户可以看到哪些主机（支持按单台主机或按分组授权）。

### API 列表

#### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/mobile/auth/login` | 用户名密码登录，返回 API Token |
| `POST` | `/api/mobile/auth/logout` | 吊销当前 Token |

**登录请求：**

```json
POST /api/mobile/auth/login
{ "username": "alice", "password": "...", "device_name": "iPhone 16" }
```

**登录响应：**

```json
{
  "token": "snav_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "token_id": 1,
  "expires_at": 1726000000000,
  "user": { "id": 2, "username": "alice", "role": "viewer" }
}
```

> ⚠️ Token 仅在登录时返回一次，请客户端安全保存。

#### 用户信息

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/mobile/profile` | 当前用户信息 + Token 列表 |

#### 主机数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/mobile/hosts` | 有权限的主机列表 + 分组 + 实时指标 + 趋势数据 |
| `GET` | `/api/mobile/hosts/:id` | 单台主机详情 + 实时指标 |
| `GET` | `/api/mobile/hosts/:id/history?range=1h` | 主机历史曲线（`1h` / `6h` / `24h` / `7d`） |

所有主机 API 自动按用户权限过滤，`viewer` 用户只能看到被授权的主机。

响应中会隐藏 `exporter_url`、`auth_header` 等敏感字段。

#### 权限管理（管理员专用，Web 端调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/users/:id/host-access` | 查看用户的主机访问权限 |
| `POST` | `/api/users/:id/host-access` | 授权（`{ "host_id": 3 }` 或 `{ "group_id": 1 }`） |
| `DELETE` | `/api/users/:id/host-access` | 撤销（`{ "access_id": 5 }`） |
| `GET` | `/api/users/:id/tokens` | 查看用户的 API Token 列表 |
| `DELETE` | `/api/users/:id/tokens` | 吊销 Token（`{ "token_id": 1 }`） |

### 移动端接入示例（cURL）

```bash
# 1. 登录获取 Token
curl -X POST https://nav.example.com/api/mobile/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"xxx","device_name":"curl-test"}'

# 2. 用 Token 拉取主机列表
curl https://nav.example.com/api/mobile/hosts \
  -H 'Authorization: Bearer snav_xxxxxxxx'

# 3. 查看某台主机 24h 历史
curl 'https://nav.example.com/api/mobile/hosts/3/history?range=24h' \
  -H 'Authorization: Bearer snav_xxxxxxxx'

# 4. 退出登录（吊销 Token）
curl -X POST https://nav.example.com/api/mobile/auth/logout \
  -H 'Authorization: Bearer snav_xxxxxxxx'
```

---

## 目录结构

```
src/
  middleware.ts              # 安全头 + API-only 模式 + 全局 IP 速率限制
  app/
    layout.tsx               # 根布局（主题、配色初始化、Toaster）
    page.tsx                 # 公开服务首页
    login/page.tsx           # 登录
    hosts/
      page.tsx               # 主机监控列表
      [id]/page.tsx          # 主机详情大图
    admin/                   # 管理后台（服务/用户/联邦/设置）
    api/
      auth/                  # login / logout / me / change-password
      services/              # CRUD + reorder + bulk
      categories/            # CRUD
      settings/              # 站点设置 + test-alert
      alerts/                # 告警历史查询 / 清空
      health/                # 单次探测 / 全量状态 (statuses)
      hosts/                 # CRUD + metrics + probe + reorder + history
      host-groups/           # 主机分组 CRUD
      mobile/                # 移动端 API（Token 认证）
        auth/                #   login / logout
        profile/             #   当前用户信息
        hosts/               #   主机列表 / 详情 / 历史
      users/                 # 用户 CRUD + host-access + tokens
      backup/                # export / import
      federation/            # push / agents / status
  components/
    nav-bar.tsx              # 顶部导航（主机/管理/登录/登出）
    theme-toggle.tsx         # 深色/浅色切换
    theme-provider.tsx       # next-themes 封装
    accent-picker.tsx        # 6 种配色主题选择器
    service-card.tsx         # 服务卡片
    home-browser.tsx         # 首页服务浏览器（搜索/分类/状态）
    hosts-browser.tsx        # 主机列表浏览器（分组/拖拽/sparkline）
    host-detail-client.tsx   # 主机详情页客户端组件
    sparkline.tsx            # SVG 迷你折线图
    time-series-chart.tsx    # 大图时序曲线（1h/6h/24h/7d）
  lib/
    db.ts                    # SQLite 初始化 + 迁移 + seed + 设置读写
    auth.ts                  # JWT cookie 会话（Web 端）
    mobile-auth.ts           # API Token 认证 + 权限查询（移动端）
    health-monitor.ts        # 服务巡检 + 历史 + 告警
    host-monitor.ts          # 主机巡检 + 历史 + 告警 + 持久化
    prom-parser.ts           # Prometheus 文本格式解析器
    alerts.ts                # Webhook 发送 + 告警事件记录 + 静默 + 裁剪
    crypto.ts                # AES-256-GCM 字段加密（credentials）
    federation.ts            # 联邦模式核心逻辑（master / agent）
    rate-limit.ts            # 登录速率限制器
    types.ts                 # TypeScript 类型定义
    utils.ts                 # 通用工具函数
data/app.db                  # SQLite 数据（自动创建）
```

---

## 常见问题

**忘记密码？**
停掉服务 → 删 `data/app.db` 里的 `users` 表（或整个文件）→ 重启时按 `.env` 重建。

**HTTP 反代下 cookie 不工作？**
如果站点已经放到 HTTPS 反代后面，请把 `.env` 里的 `COOKIE_SECURE=true` 并重启容器。直接用 `http://IP:端口` 访问时应保持 `COOKIE_SECURE=false`。

**`better-sqlite3` 安装失败？**
裸机 Linux 需要 `apt install -y build-essential python3`；Docker 默认不装编译链，只有预编译包不可用时才需要把 `.env` 里的 `INSTALL_BUILD_DEPS=true` 后重建：

```bash
docker compose build --no-cache
docker compose up -d
```

**Windows 主机的 CPU 始终是 0 / 异常？**
首次抓取没有差值，需要等第二轮（`HOST_INTERVAL_MS` 默认 30s）。"测试连接"按钮内置等待并连抓两次。

**Docker 下 SQLite 无法打开数据库文件？**
默认 `docker-compose.yml` 已改为 named volume，通常不会再碰到宿主机目录权限问题。如果你使用了 `docker-compose.bind.yml`，请确保宿主机 `./data` 对容器用户可写，例如：`sudo chown -R 1001:1001 ./data`。

**抓取不到磁盘？**
- node_exporter 默认排除了 tmpfs/proc/sys 等伪文件系统，本项目又叠加了一层过滤
- 容器里跑 node_exporter 想看到宿主机磁盘，必须挂 `/:/host:ro,rslave` 并加 `--path.rootfs=/host`（compose 里已经这么写了）

**首次启动密码警告条**
首个种子用户有 `must_change_password = 1` 标记，登录后管理页顶部会显示橙色提示，点 **立即修改** 即可清除。

**如何只暴露 API 不显示页面？**
在 `.env` 中设置 `DISABLE_WEB_UI=true`，所有 Web 页面（`/`、`/login`、`/admin`、`/hosts`）将返回 403，仅保留 `/api/*` 端点。适合只需要给移动端 App 提供数据的场景。

**修改了 `AUTH_SECRET` 后 credentials 解密失败？**
`credentials` 字段的 AES-256-GCM 加密密钥由 `AUTH_SECRET` 派生。如果更换了 `AUTH_SECRET`，已加密的 credentials 将无法解密（解密失败时返回原始密文，不会导致 500 崩溃）。建议在更换前先 **JSON 导出**（导出时自动解密为明文），更换后再导入。

---

## 安全提示

- **务必修改** `.env` 里的 `ADMIN_PASSWORD`、`AUTH_SECRET`
- 公开互联网暴露请走 HTTPS（Cloudflare、Nginx + Let's Encrypt、Caddy 任选）
- 凭据字段 `credentials` 在数据库中使用 **AES-256-GCM 加密**（密钥由 `AUTH_SECRET` + `scrypt` 派生 32 字节密钥，首次启动会自动把已有明文加密升级）。注意：**`AUTH_SECRET` 丢失将无法解密旧 credentials**，请务必备份
- **双层速率限制**：
  - **全局 IP 限速**（中间件层）：同一 IP 在 `GLOBAL_IP_WINDOW_MS`（默认 60s）内对认证端点（`/api/auth/login`、`/api/auth/change-password`、`/api/mobile/auth/login`）最多 `GLOBAL_IP_MAX_REQUESTS`（默认 30）次请求
  - **用户级限速**（应用层）：同一 `IP + username` 连续 `LOGIN_MAX_FAILS`（默认 5）次错密码会锁定 `LOGIN_LOCK_MS`（默认 15 分钟），返回 `429`
  - 修改密码接口同样受速率限制保护
- **安全响应头**（中间件自动注入）：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`X-XSS-Protection`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`（禁用摄像头/麦克风/地理位置）；API 响应自动加 `Cache-Control: no-store`
- **API-only 模式**：设置 `DISABLE_WEB_UI=true` 后所有 Web 页面返回 403，仅保留 API 端点，适合只给移动端 App 提供接口的场景
- 主机的 `auth_header` 字段只在已登录状态下返回；未登录的公开 API 响应会剥掉它
- 联邦模式下节点推送会自动脱敏，不推送 `credentials`、`notes`、`internal_url`、`auth_header`
- 若使用 bind mount 持久化 SQLite 文件，建议对宿主机数据库文件收紧权限

---

## 路线图

- [x] 服务导航 + 健康检查 + sparkline + tab 离线徽章
- [x] 跨分类拖拽 / 批量导入 / JSON 备份恢复
- [x] 修改密码 + 默认口令风险提示
- [x] 主机监控（node / windows exporter）+ CPU / 内存 / 磁盘 / 网络吞吐 + 阈值告警
- [x] 主机分组 + 跨分组拖拽排序
- [x] 主机详情页（1h / 6h / 24h / 7d 大图曲线，hover 游标）
- [x] 主机历史持久化到 SQLite + 按区间聚合
- [x] Docker compose + node_exporter sidecar（monitoring profile）
- [x] 多用户管理 + 角色（admin / viewer）
- [x] 移动端 API（Bearer Token + 按用户权限过滤主机）
- [x] 联邦模式（master / agent 多站点聚合监控）
- [x] 深色/浅色主题 + 6 种配色方案
- [x] 凭据 AES-256-GCM 加密存储
- [x] 双层速率限制 + 安全响应头
- [x] API-only 模式（`DISABLE_WEB_UI`）
- [ ] 移动端 App（Flutter / React Native）
- [ ] 飞书 / 企业微信原生卡片格式
- [ ] PWA + 移动端图标

PR / Issue 欢迎。
