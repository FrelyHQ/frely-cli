# frely-cli

[English](README.md) · [简体中文](README.zh-CN.md)

`frely-cli` 把你指定的一台电脑变成 AI Agent 可以在任何地方操作的设备。ChatGPT、Claude、Codex 等 MCP 客户端通过 **FrelyMCP** 连接，使用你授权的文件夹里的文件、Shell 命令和进程。电脑主动向 Frely 发起连接，不需要开放任何端口。

它也是 Frely 账号的命令行工具：

- **设备 MCP**：让远程 AI 客户端操作这台电脑。
- **本机 MCP 服务**：把只在这台电脑上运行的 MCP 服务（例如监听 `127.0.0.1` 的）转给远程客户端使用。
- **Agent、Prompt 与 Skill**：把已发布的 Frely Agent 安装为本地 Skill，或安装你购买的 Prompt 和 Skill。
- **本地模型共享**：把本机 Ollama 或 OpenAI 兼容运行时发布为你自己的 Frely Provider。

## 安装

### 服务器，已有 Frely 账号（无需浏览器）

拿到一条一次性安装命令，粘贴到服务器上运行。它会安装 `frely`、登录你的账号、开启设备 MCP 并启动后台服务，全程不打开浏览器，也不会提问。

在以下任一处获取命令：

- Frely 网站：**My Devices → Add a computer → Create install command**。
- 已连接 FrelyMCP 的 ChatGPT 或 Claude：让它添加一台电脑，`list_devices` 会返回这条命令。

命令形如：

```sh
curl -fsSL https://frely.cloud/start.sh | FRELY_INSTALL_TOKEN=fit_... sh
```

令牌只能用一次，15 分钟内有效，不会保存在电脑上。如果这台电脑已经安装或登录过 Frely，命令会更新它，并把登录切换到你的账号。Linux 上请运行 `sudo loginctl enable-linger $USER`，退出 SSH 后服务才能保持在线。

### 有浏览器的电脑

```sh
# macOS / Linux
curl -fsSL https://frely.cloud/start.sh | sh
```

```powershell
# Windows（PowerShell）
curl.exe -fsSLo "$env:TEMP\frely-start.ps1" https://frely.cloud/start.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-start.ps1"
```

脚本安装最新版 `frely`，然后运行 `frely mcp start`：打开浏览器登录（新账号可在同一页面注册），请你批准这台设备，最后输出 MCP URL。随时可以再运行一次来升级，它会用新版本重启后台服务。

工作区默认是用户主目录（凭据和 Shell 启动文件仍受保护）。设置 `FRELY_WORKSPACE=/path` 可共享其他文件夹，`FRELY_INSTALL_DIR` 可改变安装位置（默认 `~/.local/bin`）。

### 只安装

`install.sh` 和 `install.ps1`（同一域名，`https://frely.cloud/install.sh`）只安装程序，供脚本、Skill 和 Agent 使用。也可以用 npm（需要 Node.js 22 或更新版本）：

```sh
npm install --global --ignore-scripts frely-cli@latest
```

安装器会选择对应平台的可执行文件，校验 SHA-256，安装到用户目录，不需要 Node.js。下载先走 GitHub Releases，GitHub 过慢或连不上时改用 npmmirror 和 npmjs（`@frelyhq/cli-<平台>`）。`FRELY_INSTALL_SOURCES` 可调整顺序。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `frely mcp start` | 需要时先登录，开启设备 MCP，启动服务并输出 MCP URL。可重复运行。 |
| `frely mcp status` | 显示 MCP URL、工作区、授权到期时间和服务状态。 |
| `frely mcp workspace add <path>` | 再共享一个文件夹。`frely mcp workspace list` 列出全部。 |
| `frely mcp stop` / `frely mcp start` | 暂停或恢复后台服务。 |
| `frely mcp remove` | 撤销所有客户端的访问并卸载服务。 |
| `frely doctor` | 检查登录、安装、服务和连接状态。加 `-v` 看详情。 |
| `frely update` | 原地升级到最新版。 |
| `frely login` / `frely logout` | 登录或退出 Frely 账号。 |
| `frely uninstall` | 从这台电脑移除 Frely（先列出全部内容）。 |

只输入命令组而不带子命令（如 `frely mcp`、`frely agent`）会列出该组的子命令。

## 与 FrelyMCP 配合使用

FrelyMCP 是整个账号共用的一个 MCP 地址：`https://mcp.frely.cloud/mcp`。每台运行过 `frely mcp start` 的电脑都在它后面。`frely-cli` 在各台电脑上执行工具，AI 客户端只需要这个 URL。

### 连接客户端

1. 在要被控制的电脑上运行 `frely mcp start`（上面的安装脚本已经包含这一步），它会输出 MCP URL。
2. 把 URL 作为使用 OAuth 的远程 MCP 服务加到客户端：
   - ChatGPT 或 Claude：用这个 URL 添加自定义连接器。
   - 另一台电脑上的 Claude Code：`claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"`，然后打开 `/mcp` 完成授权。
3. 登录 Frely 并批准该客户端。

验证连接：让客户端列出工作区的顶层文件名，结果与文件夹一致即表示连通。

### AI 能做什么

- `list_devices` 列出你的电脑、是否在线及其工作区。没有电脑时，它会给出上面的安装命令。
- 设备工具带 `device` 参数，在那台电脑上执行：
  - `read`：在工作区内列出、读取、搜索和查找文件。
  - `edit_file`：原子地写入整个文件或按行修改。
  - `process`：运行 Shell 命令，或启动和管理长时间运行的进程。
  - `web_fetch`：读取公开网页。
- `local_mcp_list` 和 `local_mcp_call` 访问那台电脑上你已开启的 MCP 服务（见下文）。
- `frely_list` 和 `frely_call` 管理你的 Frely 账号（API Key、Credit、套餐、订单）。终端里的 `frely api list|describe|call` 是同一套操作。

AI 客户端自带的 Shell 仍在客户端所在的电脑上运行；要在你的电脑上工作，请让它使用 Frely 工具。所有客户端共享每台电脑的工作区和正在运行的进程。

### 本机 MCP 服务

只监听本机回环地址的服务会被自动发现（`frely mcp local list`）。其他服务这样添加：

```sh
frely mcp local add <name> --url http://127.0.0.1:<port>/mcp
frely mcp local add <name> [--env KEY=VALUE] -- <command> [args...]   # stdio
```

每个服务默认对远程客户端隐藏，需要在 Frely 连接页面逐个开启。开启后的服务在命令沙箱之外、以你的用户身份运行。只会连接回环地址，headers 和环境变量不会离开这台电脑。

### 授权

设备 MCP 授权默认 90 天；`frely mcp start --days 1..365` 可提前续期。到期后 `frely mcp start` 会再次请求批准。URL 永远不变。在 Frely 网站的 **My Devices** 管理你的电脑。

## 更多功能

### 调用 Frely 托管的 Agent

```sh
frely agent install <distribution-id> --host claude-code --scope global
printf '%s' 'Your complete task' | frely agent run <distribution-id> --input-stdin --json
```

`--host` 可选 `chatgpt`、`codex`、`claude-code`、`pi` 或 `generic`。也可以用完整的 manifest URL 代替 id。要用 Creator 提供的赞助 API Key 而不是你的账号，用 `--api-key-stdin` 从 stdin 传入；Key 存入安全凭据库，不会写进 Skill。请使用短期、单模型、限额的 Key。`frely agent status <id>` 显示 Skill 和 Key 的额度；`frely agent remove <id>` 同时移除两者。

### 安装市场里的 Prompt 和 Skill

```sh
frely item install <item-id> --host claude-code
```

首次调用会打开浏览器进行 Frely Cloud 授权。账号持有通行证时才安装付费部分，否则命令会告诉你如何购买。Skill 装到宿主的 Skill 目录，Prompt 装到 `--dir`（默认当前目录），脚本保存时不带执行权限。Frely 不会覆盖不是它安装的文件夹，也不会覆盖你改过的文件。审查过已安装的条目后，`frely item trust <folder>` 会记住；新版本需要重新审查。

你购买的云端 MCP 不会安装到电脑上：在 Frely 网站为某个连接开启后，它们的工具会出现在 FrelyMCP 里。

### 本地模型共享

```sh
frely provider share ollama
frely provider share openai-compatible --url http://127.0.0.1:8080/v1 --models model-a,model-b --name "Local GPU"
frely provider list
```

把本机回环地址上的 OpenAI 兼容端点（默认 Ollama `http://127.0.0.1:11434/v1`）发布为 Frely 个人 Provider，占用一个空的个人 Provider 名额。没有空名额或使用 `--creator` 时，会创建 Creator Provider，计入你的 Creator 套餐，其模型可作为你发布的 Agent 的底座。使用期间请保持电脑在线，并确保运行时在响应中返回 `usage`。设置中途停止时，再次运行同一命令即可继续。

## 本地执行边界

- **文件**：文件工具只在共享的工作区内操作，拒绝符号链接逃逸，单次读写上限 1 MiB，写入是原子的。即使在主目录内，凭据库和 Shell 启动文件也受保护。
- **命令**：`process` 以你的系统用户身份在系统级沙箱中运行。凭据目录不可读，写入限于工作区和临时目录，网络经代理。电脑无法使用沙箱时（Windows，或 Linux 缺少 `bubblewrap`、`socat`、`ripgrep`），命令会被拒绝而不是在沙箱外运行。可以在 Frely 连接页面开放更多：可读的凭据目录、可写的其他目录，或限时无沙箱运行。在设备上设置 `FRELY_SANDBOX=off` 可关闭沙箱。
- **凭据**：MCP URL 不含任何密钥。客户端持有 OAuth 令牌；CLI 持有独立的 MCP 执行密钥，用 macOS 钥匙串、Windows 凭据管理器或 Linux Secret Service 中的主密钥加密。无界面的机器可设置 `FRELY_CREDENTIAL_KEY`（32 字节）并配合 `FRELY_CREDENTIAL_STORE=encrypted-file`。授权到期后，请求和排队的工作会停止；已完成的写入不会撤销。

详情：[凭据与安装边界](docs/credential-storage.md)。

## 升级、诊断与卸载

```sh
frely doctor      # 账号、安装、最新版本、MCP 与服务状态
frely doctor -v   # 另含配置路径、授权到期、最后心跳、脱敏错误
frely update      # 原地升级，保留登录、设备、URL 和工作区
frely uninstall   # 先列出全部内容，输入 yes 后移除（脚本用 --yes）
```

`frely update` 保持原有安装方式，不会降级。它暂停后台服务，校验后替换程序，再重启服务。Windows 上它会输出一条 PowerShell 命令，请在本地终端运行。见[自更新](docs/self-update.md)和[服务维护](docs/service-maintenance.md)。

`frely uninstall` 在 Frely 端撤销这台电脑的访问，移除服务、保存的登录、设备身份、设置、缓存和 Frely 安装的 Agent Skill，最后移除 `frely` 程序本身。它会保留 Frely App、账号里的 Provider 和 Agent、安装器添加的 PATH 行、你改过的 Skill 和市场条目。请在本地终端运行，不要通过设备 MCP 运行。

## 全部命令

```text
frely login [--relay <https-url>] [--no-browser]
frely login --email <address> [--mcp] [--workspace <path>]   then   frely login --code <6-digit code>
frely logout
frely uninstall [--yes] [--json]
frely doctor [-v] [--json]
frely update
frely mcp start [--workspace <path>] [--days 1..365] [--no-browser] [--json]
frely mcp status [--json]
frely mcp stop|remove
frely mcp workspace list [--json]
frely mcp workspace add|remove <path>
frely mcp local list [--json]
frely mcp local add <name> (--url <address> | [--env KEY=VALUE] -- <command> [args...])
frely mcp local remove <name>
frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]
frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]
frely agent remove <distribution-id> [--json]
frely item install <item-id> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]
frely item trust <folder> [--check]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id> | --creator] [--name <name>]
frely provider list [--json]
frely api list|describe|call
```

`frely help --agent --json` 输出完整的机器可读契约，包括 `frely --help` 中未列出的命令：`frely mcp stdio`（通过 stdio 向本地客户端提供工具）、`frely mcp serve`（后台服务运行的前台进程）和 `frely network`（预览）。

## 文档

- [设备 MCP](docs/device-mcp.md)
- [Device Relay 传输](docs/device-transport.md)
- [MCP OAuth 契约](docs/mcp-oauth-relay-contract.md)
- [`frely api`](docs/api.md)
- [Frely Network（预览）](docs/frely-network.md)

## 许可与商标

`frely-cli` 采用 Apache License 2.0 许可，见 [`LICENSE`](LICENSE)。Frely 名称、标志和产品名不随商标授权，见 [`TRADEMARKS.md`](TRADEMARKS.md)。开发说明见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，私下报告漏洞见 [`SECURITY.md`](SECURITY.md)。
