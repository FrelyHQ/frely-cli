# Frely CLI 与 ChatGPT MCP

状态：实施中。

## 产品目标

`frely-cli` 提供 Frely 账号登录、本机 MCP runtime、设备身份、后台服务与 Device Relay 客户端。

目标用户路径：

```text
安装 frely-cli
  -> frely login
  -> frely mcp setup --workspace <path>
  -> 获得私有 MCP URL
  -> ChatGPT 添加 Custom MCP
  -> ChatGPT MCP 请求进入 Friday Relay
  -> Friday Relay 转发请求到 frely-cli
  -> frely-cli 执行本机 MCP 工具
```

`friday-relay` 只承担中继、设备授权、连接管理和公网 MCP 入口。本机文件、Shell、进程和 MCP 工具属于 `frely-cli`。

本方案没有独立 `friday-local` 项目或 runtime 产品。

## 安装

仓库安装脚本：

```bash
./install.sh
```

生产安装入口目标：

```bash
curl -fsSL https://app.frely.cloud/install.sh | sh
```

安装脚本从 `app.frely.cloud` 下载版本化 `frely-cli` tarball，校验固定 SHA-256 后使用本机 npm 安装，并提供 `frely` 命令。该入口不依赖 `@frely/cli` 已发布到公共 npm registry。

## 账号登录

```bash
frely login
```

CLI 使用 Frely Web 账号。密码只进入 TTY 登录请求。密码不写入配置、argv、环境和日志。

Frely session 存储位置：

- macOS：Keychain
- Linux：Secret Service

普通配置只保存 Relay origin 与公开用户信息。

## MCP 初始化

```bash
frely mcp setup --workspace ~/project
```

该命令负责：

1. 检查 Frely session。
2. 创建 Ed25519 设备密钥。
3. 向 Relay 注册账号所属设备。
4. 获取私有 MCP URL。
5. 安装用户级后台服务。
6. 启动 Device Relay WebSocket 客户端。

后台服务：

- macOS：LaunchAgent
- Linux：systemd user service

设备不开放公网监听端口。连接方向为设备到 Relay 的 outbound WebSocket。

## MCP URL

```bash
frely mcp url
```

URL 形态：

```text
https://app.frely.cloud/mcp/<device-id>/<private-secret>
```

`private-secret` 使用 384-bit 随机值。Relay 数据库存储 SHA-256 hash，不存储明文 secret。

私有 MCP URL 本身属于 bearer credential。持有 URL 的主体拥有对应设备 MCP 访问权。URL 不进入普通日志、metrics、trace、audit metadata、Referer、公开页面或共享截图。

该安全模型不要求 ChatGPT MCP OAuth。ChatGPT 的 MCP Authentication 使用 `None`。

设备撤销会使该 URL 失效：

```bash
frely mcp revoke
```

设备重新 enrollment 会轮换 MCP secret，并使旧 URL 失效。

## ChatGPT 配置

```bash
frely mcp chatgpt
```

命令输出 MCP URL 与后台服务状态。

ChatGPT 配置：

```text
MCP URL: <frely mcp url 输出>
Authentication: None
```

URL 需要私密保存。

## Device Relay

设备连接使用协议：

```text
frely.device-relay.v1
```

连接 grant 使用短期 bearer token。token 来自账号 session + Ed25519 device proof。WebSocket URL 不携带该 token；token 位于 `Authorization` header。

数据路径：

```text
ChatGPT
   |
   | MCP JSON-RPC / HTTPS
   v
Friday Relay /mcp/<device>/<secret>
   |
   | frely.device-relay.v1
   | request / response / cancel
   v
frely-cli
   |
   v
local MCP runtime
   |- workspace / files
   |- shell
   |- persistent processes
```

每个 Relay 请求拥有独立 request id。设备支持 64 个 inflight 请求窗口。只读工具支持有界并发。mutation 与 Shell 使用写队列。该模型不使用 LocalMCP 的 device-wide single-flight `429`。

## 失败语义

- 无效 MCP URL：HTTP 404。
- 设备离线：HTTP 503。
- inflight 窗口耗尽：HTTP 503。
- 设备请求超时：HTTP 504。
- mutation 超时或连接中断：结果可能未知；Relay 不做自动重放。
- 设备撤销：MCP URL 拒绝请求，设备 WebSocket 关闭。

## 本机安全边界

文件工具限制在选定 workspace。实现包含 symlink escape 检查、`O_NOFOLLOW` 读取、hard-link 覆盖保护、原子文件替换和 stale patch hash。

Shell 与 persistent process 使用运行 `frely-cli` 的 OS 用户权限。workspace 只约束工作目录，不构成 Shell sandbox。

## 命令面

```text
frely login [--relay <url>]
frely logout
frely whoami
frely status [--json]
frely doctor [--json]

frely mcp setup [--workspace <path>]
frely mcp url [--json]
frely mcp status [--json]
frely mcp chatgpt
frely mcp serve [--workspace <path>]
frely mcp service status|start|stop|uninstall [--json]
frely mcp revoke
frely mcp stdio [--workspace <path>]
```

## 服务端合同

`frely-cli` 使用以下 Friday Relay 控制接口：

```text
POST /api/user/device-relay/enroll
POST /api/user/device-relay/connect
POST /api/user/device-relay/revoke
```

公网数据入口：

```text
POST /mcp/<device-id>/<private-secret>
GET  /device-relay/ws?deviceId=<device-id>   # WebSocket upgrade
```

`enroll` 返回 `deviceId` 与私有 `mcpUrl`。`connect` 返回 `websocketUrl`、短期 `accessToken` 与 `expiresAt`。`revoke` 终止设备授权。

## 验收状态

`frely-cli` 已覆盖：

- npm package 构建与安装脚本
- Frely 账号登录门禁
- OS credential store
- Ed25519 device identity
- enroll/connect/revoke client
- MCP URL client
- LaunchAgent/systemd user service
- Device Relay WebSocket client
- MCP JSON-RPC bridge
- 本地工具 runtime
- 多请求 inflight 与读写调度

Friday Relay 服务端承担剩余公网入口、持久设备事实与转发运行时。
