# frely-cli

[English](README.md) · [简体中文](README.zh-CN.md)

`frely-cli` 把你指定的一台电脑变成 AI Agent 可以远程操作的安全设备。浏览器 Agent（ChatGPT、Codex）和命令行 Agent（Claude Code、pi）通过 Model Context Protocol（MCP）连接，访问你授权的工作区（workspace）内的文件、命令与进程——在任何地方。

两个可选功能，各自有独立的配置与授权：

- **Remote Agent Skill** —— 把已发布的 Frely Agent 安装为本地触发 Skill，从自动化流程中调用。
- **本地模型共享** —— 把本机 Ollama / OpenAI 兼容运行时发布为你的 Frely 个人 Provider。

本仓库包含开源的 Frely 客户端与本地 MCP 运行时；托管的 Frely Relay 控制面是独立的服务依赖。不存在独立的 `friday-local` 项目，本地 MCP 执行属于 `frely-cli`。

```text
Remote Agent Skill: 安装 -> frely login -> frely skill install -> frely agent invoke
Device MCP:  在被控电脑安装 -> frely login -> frely mcp -> 客户端添加 MCP URL -> OAuth 授权
```

## 安装

独立安装器（standalone installer）会选择平台可执行文件、校验 SHA-256 并安装到用户目录，不需要 Node.js、npm 或 keyring。

```sh
# macOS / Linux
curl -fsSL https://app.frely.cloud/install.sh | sh
```

```powershell
# Windows
irm https://github.com/FrelyHQ/frely-cli/releases/latest/download/install.ps1 | iex
```

或使用 npm（需要 Node.js 22 或更新版本）：

```sh
npm install --global --ignore-scripts frely-cli@latest
```

要安装指定版本，把 `latest` 换成版本号。带 tag 的发布会在跨平台验证后同时发布 npm 包与 GitHub Release 独立安装产物。

### 从源码安装

用 Bun 安装当前源码：

```sh
cd /path/to/frely-cli
bun install
bun run build
bun install --global "$PWD"
```

全局安装命令请使用 `$PWD` 绝对路径。如果找不到 `frely`，把 Bun 全局 bin 目录加入 `PATH`：

```sh
export PATH="$(bun pm bin -g):$PATH"
```

当前源码没有 keytar 依赖和原生 npm 构建步骤。依赖安装支持 `npm ci --ignore-scripts` 与 `bun install --ignore-scripts`。仓库以 npm 作为 CI 与发布的规范包管理器并提交 `package-lock.json`；Bun 仅用于本地开发，变更依赖时请保持 lockfile 同步。

## 首次使用

用消费端使用的 Frely 账号登录一次：

```sh
frely login
```

浏览器会自动打开。要换浏览器或换账号，运行 `frely login --no-browser`，并把打印的 URL 只在你想要的那个账号已登录的浏览器中打开。在已登录状态下访问设备授权 URL，可能在点击 Approve 之前就把该码绑定到那个账号——如果默认浏览器用别的账号打开了，按 Ctrl+C，重新运行 `frely login --no-browser`，使用**新的 URL**。重新登录或复用旧 URL 都不会切换账号。使用自建 Relay 时请保留 `--relay <url>`。`FRELY_NO_BROWSER=1` 仍然支持。

### Device MCP：让远程客户端控制这台电脑

在被控电脑上开启文件、shell 与进程访问：

```sh
frely mcp --workspace /path/to/project
```

`frely login` 通过浏览器设备授权获取受限账号会话。`frely mcp` 初始化独立的 MCP 安全密钥、请求浏览器批准该设备与工作区，并安装用户级 Device Relay 服务（macOS LaunchAgent、Linux systemd 用户单元或 Windows 任务计划程序）。默认授权 90 天，`--days 1..180` 可选时长。

打印要添加到 MCP 客户端的 URL：

```sh
frely mcp url
```

如果 MCP 尚未配置，`frely mcp url` 会自动执行等价的 `frely mcp setup --workspace ~`：请求浏览器批准家目录（默认 90 天），然后安装后台服务并打印 URL。请先运行 `frely login`。安装提示走 stderr，stdout 保持单一 URL（或 `--json` 时一个 JSON 对象）；批准或安装失败则不打印 URL。

把打印的完整 URL 添加到支持 OAuth 的远程 MCP 客户端，选择 OAuth 并完成授权。保持电脑在线。验证首次连接：让客户端只列出所选工作区的顶层名称，不写文件、不跑 shell 命令——返回与目录一致的结果即连通。

调用端的 Claude Code：

```sh
claude mcp add --transport http frely-computer "<MCP_URL>"
```

在 Claude Code 中打开 `/mcp` 完成 OAuth 授权。每台设备使用不同的服务器名。让 Agent 用 Frely 工具做远程工作；它自带的 shell 仍跑在调用端电脑。同一设备的客户端共享其工作区与托管进程。

授权生命周期：`frely mcp renew --days 180` 需要新的批准并轮换 MCP 执行密钥。MCP URL 始终绑定该设备。登录刷新、OAuth 刷新、重启与重复配置都不延长授权。在 Frely → **Device MCP**（`/user/account/connections`）管理你的设备。`frely mcp setup` 与 `frely mcp chatgpt` 仍是兼容别名；不带参数的 `frely mcp` 使用当前目录。

### 调用 Frely 托管的 Agent

使用有账号或受限 API-key 访问权限的已发布 Agent。安装为本地触发 Skill：

```sh
frely skill install https://app.frely.cloud/api/public/virtual-models/<distribution-id> \
  --host pi \
  --scope global \
  --json
```

Creator 也可以提供一个现成的模型级、限额 API key 用于赞助/演示调用。只通过 stdin 传入，避免出现在 argv 或生成的 Skill 中：

```sh
printf '%s' "$FRELY_AGENT_KEY" | \
  frely skill install https://app.frely.cloud/api/public/virtual-models/<distribution-id> \
    --host chatgpt \
    --scope global \
    --api-key-stdin \
    --json
```

CLI 会用目标模型级 MCP `tools/list` 端点验证 key，存入安全凭证库，在托管 Skill 元数据中只记录 `authMode=api-key`。分享请使用短生命周期、单模型、限额的 key；不要把 Creator 主 key 贴进去。

生成的 Skill 通过 Frely 的模型级 MCP 端点调用已发布 Agent。从自动化调用已安装 Agent，完整任务走 stdin：

```sh
printf '%s' '你的完整任务' | \
  frely agent invoke '<distribution-id>' --input-stdin --json
```

## 本地模型共享

把回环（loopback）OpenAI 兼容运行时发布为 Frely 个人 Provider，Ollama 是默认驱动：

```sh
frely provider share ollama
```

自定义端点与模型选择：

```sh
frely provider share openai-compatible \
  --url http://127.0.0.1:8080/v1 \
  --models model-a,model-b \
  --slot <personal-provider-slot-id> \
  --name "Local GPU"
```

要求：已登录 Frely、一个空闲的活跃个人 Provider slot、回环 HTTP、OpenAI 兼容 `/v1`（Ollama 默认端点 `http://127.0.0.1:11434/v1`）。模型名不能包含空格或 `/`。

该命令创建服务端管理的 `openai-compatible` 个人 Provider，把本地端点存入仅属主可读的 CLI 状态，启动 Device Relay 服务，用设备 Ed25519 key 签署 Provider 凭证，配置 CPA 并启用声明的模型。现有 Frely Access Point 与 API-key 流程即可消费该 Provider。

Provider 检查与恢复：

```sh
frely provider list
frely provider finalize <provider-id>
```

`finalize` 为停留在 prepared 状态的 Provider 续跑 CPA 配置。

## 升级与诊断

```sh
frely doctor      # 安装路径、发行形态、最新稳定版、本地账号/MCP/服务状态
frely doctor -v   # 另加配置路径、运行时细节、授权到期、最近心跳、脱敏错误
frely upgrade     # 原地升级当前正在运行的安装
```

`frely upgrade` 永不换安装器、不改 PATH、不降级更新版本。standalone 下载会先校验 SHA-256 并做启动测试再替换可执行文件；npm/Bun 安装保持原全局目录。匹配的、正在运行的 Device Relay 服务会被暂停维护、重启并在安装后检查；凭证、设备身份、MCP URL、工作区与授权到期均保留。Windows 上 `upgrade` 打印检测到安装方式对应的 PowerShell 命令，请在本地终端执行。

`frely doctor` 是唯一诊断入口，永不重启服务。“Connected” 表示匹配的账号/设备进程在 75 秒内收到 WebSocket 心跳，且 MCP 授权与工作区与运行中的 relay 匹配。两种模式都不代替客户端完成 OAuth 授权，也不代替执行工具调用。旧的 `frely status`、`frely mcp status`、`frely mcp service status` 与 `frely doctor --mcp` 保持兼容，但 `frely doctor` 是推荐入口。

完整行为：[self-upgrade 契约](docs/self-upgrade.md) 与[服务维护与旧版本迁移](docs/service-maintenance.md)。若安装了多个 `frely`，升级前先查看 `doctor` 显示的路径。

## 本地执行边界

本地 MCP 服务暴露：工作区检查、文件搜索/读/写/补丁、目录创建/删除/移动、shell 命令、常驻进程管理。

文件系统工具约束在所选工作区内：拒绝 symlink 逃逸、普通文件读写上限 1 MiB、no-follow 读、原子替换写。`run_command` 与常驻进程工具以当前 OS 用户权限执行；工作区只约束它们的工作目录，**不是** shell 沙箱。

只读本地操作可以并行；写与 shell 操作走本地公平调度器——避免了设备级 `busy -> 429` 行为。

## 认证与密钥

基础账号会话与 Network 会话使用私有明文文件，不能批准 MCP 授权，也不能在显式范围外调用账号管理操作。Provider key 与 MCP 执行 key 相互独立。

MCP 密钥使用 AES-256-GCM 文件，主密钥存 macOS Keychain、Windows 凭据管理器或 Linux Secret Service。无头部署可通过 `FRELY_CREDENTIAL_KEY` 注入 32 字节 key 并设 `FRELY_CREDENTIAL_STORE=encrypted-file`。MCP 没有明文回退；安全存储失败不影响基础功能。

稳定的 MCP URL 不含凭证。远程客户端持有 OAuth 凭证；CLI 持有 MCP 执行私钥。Relay 校验 OAuth 资源绑定与当前 MCP 执行租约。到期会阻塞请求与排队任务、取消托管执行，但不回滚写入，也不为任意 shell 程序提供沙箱。

存储、迁移、服务注入、发布要求与威胁边界：[凭证与安装边界](docs/credential-storage.md)。

## 架构

- 产品定义与通用客户端接入：[docs/device-mcp.md](docs/device-mcp.md)
- Device Relay 传输：子协议、连接 grant、重连、回退状态机：[docs/device-transport.md](docs/device-transport.md)
- Relay OAuth 2.1 Authorization Code + PKCE、发现与 token 端点：[docs/mcp-oauth-relay-contract.md](docs/mcp-oauth-relay-contract.md)
- Cloud 命令与授权：[docs/cloud.md](docs/cloud.md)
- Frely Network 命令（未发布）：[docs/frely-network.md](docs/frely-network.md)

公网 MCP URL 是 Relay 返回的规范资源，例如 `https://connect.frely.cloud/mcp/<device-id>`。请使用 `frely mcp url`，不要从控制面域名推导。URL 不含 bearer secret。

## 命令

```text
frely login [--relay <https-url>] [--no-browser]
frely logout
frely whoami
frely doctor [-v] [--json]
frely upgrade
frely skill install <manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely skill status <distribution-id> [--json]
frely skill remove <distribution-id> [--json]
frely agent invoke <distribution-id> (--input <text>|--input-stdin) [--json]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]
frely provider list [--json]
frely provider finalize <provider-id>
frely mcp [--workspace <path>] [--days 1..180]
frely mcp renew [--days 1..180]
frely mcp url [--json]
frely mcp serve [--workspace <path>]
frely mcp service start|stop|uninstall
frely mcp revoke
frely mcp stdio [--workspace <path>]
```

`frely mcp serve` 是 Device Relay 客户端的前台形式。远程执行需要已批准的工作区与 MCP 租约；只有 Provider 的连接不开启 MCP。

`frely logout` 删除账号会话并尝试停止后台服务。`frely mcp revoke` 撤销 MCP 租约并删除其安全凭证；保留 Provider 设备与服务。

## 落地页

开源 CLI 落地页在 [`site/`](site/README.md)，与 CLI 同处 Apache-2.0 许可与商标政策下，为 `cli.frely.cloud` 准备，作为静态站点独立部署。网站资源不打进 npm 包。

## 许可与商标

`frely-cli` 采用 Apache License 2.0，见 [`LICENSE`](LICENSE)。Frely 名称、logo 与产品名不作为商标授权，见 [`TRADEMARKS.md`](TRADEMARKS.md)。

开发指引见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，私有漏洞报告见 [`SECURITY.md`](SECURITY.md)。
