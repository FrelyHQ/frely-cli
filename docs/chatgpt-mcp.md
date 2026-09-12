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

`frely-cli` 要求 Node.js 22 或更高版本。

### 使用 npm 安装或更新

要从 npm 安装或更新到最新版，请运行：

```bash
npm install --global frely-cli@latest
```

要安装或更新到指定版本，请将 `latest` 替换为版本号。例如，使用 `0.3.6`：

```bash
npm install --global frely-cli@0.3.6
```

### 从本地源码安装（Bun）

要从当前源码目录安装全局 `frely` 命令：

```bash
cd /path/to/frely-cli
bun install
bun run build
bun install --global "$PWD"
```

全局安装时使用绝对路径 `$PWD`。如果终端找不到 `frely`，将 Bun 的全局 bin 目录加入当前 shell 的 `PATH`：

```bash
export PATH="$(bun pm bin -g):$PATH"
```

如果 Bun 报告 `keytar` 的生命周期脚本被阻止，在源码目录执行以下命令，然后重新构建并安装：

```bash
bun pm trust keytar
bun install
bun run build
bun install --global "$PWD"
```

当前仓库使用 npm lockfile，没有提交 Bun lockfile。第一次执行 `bun install` 可能会生成 `bun.lock`，请按仓库的 lockfile 约定处理该文件。

### 使用仓库安装脚本

仓库安装脚本：

```bash
./install.sh
```

生产安装入口目标：

```bash
curl -fsSL https://app.frely.cloud/install.sh | sh
```

安装脚本检查本机 Node.js/npm 版本，然后从公共 npm registry 安装 `frely-cli@latest` 并提供 `frely` 命令。可以通过 `FRELY_CLI_VERSION` 指定版本，或通过 `FRELY_CLI_PACKAGE` 覆盖完整 npm package spec：

```bash
curl -fsSL https://app.frely.cloud/install.sh | FRELY_CLI_VERSION=0.3.0 sh
curl -fsSL https://app.frely.cloud/install.sh | FRELY_CLI_PACKAGE='frely-cli@next' sh
```

### 更新已有安装

如果已经通过官方安装脚本安装 `frely-cli`，请重新运行[安装脚本](#使用仓库安装脚本)中的命令，脚本会更新到最新版本。

如果通过 npm 安装，请重新运行[使用 npm 安装或更新](#使用-npm-安装或更新)中的相应命令。

如果本机安装了多个 `frely` 可执行文件，请先查看命令路径和 npm 全局安装位置：

```bash
type -a frely
npm prefix --global
"$(npm prefix --global)/bin/frely" --version
```

终端会使用 `PATH` 中排在最前面的 `frely` 路径。如果该路径不是 npm 的全局 bin 目录，请将 `$(npm prefix --global)/bin` 放到 `PATH` 的前面，然后重新运行 `frely --version`。

如果 Device Relay 后台服务正在运行，更新后重启服务，使服务加载新的 CLI 版本：

```bash
frely mcp service stop
frely mcp service start
```

检查更新结果：

```bash
frely --version
frely doctor
```

## 账号登录

```bash
frely login
```

CLI 使用 Frely Web 账号。`frely login` 会启动 Better Auth Device Authorization，在浏览器中显示明确的授权页面并等待批准；密码只在浏览器登录流程中处理，不进入 CLI 的 argv、环境或日志。

授权完成后，CLI 将 OAuth access/refresh token 存入操作系统凭据库。令牌不会写入配置文件、URL 或日志；旧版 session cookie 仍可在迁移期间读取。

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
