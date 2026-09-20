# Frely 设备 MCP 服务

新地址使用 `connect.frely.cloud`；旧 `mcp.frely.cloud` 暂时继续服务，旧 URL、OAuth resource 与 token audience 保持原值，不重定向、不自动改写。

状态：本文描述当前源码的两层授权、稳定 MCP URL 与 OAuth 契约。2026-09-17 核验 npm registry 与 0.6.2 发行包：设备 MCP、Provider、Agent install/invoke 命令均包含在发行包中。CLI 命令发布与服务端部署、真实调用验收分别判断。

<a id="first-connection"></a>

## 完成首次本地工具连接

1. 安装 CLI 并执行 `frely login`。npm 安装需要 Node.js 22 或更新版本，独立发行版自带运行时。
2. 在准备共享的文件夹中执行 `frely mcp`，在浏览器中确认设备、工作区和授权期限。Shell 使用当前系统用户权限，工作区不是 Shell 沙箱。
3. 执行 `frely mcp url`，将输出的完整地址添加到支持 OAuth 的远程 MCP 客户端。选择 OAuth，完成客户端授权；不要自行拼接地址。
4. 保持电脑运行和联网。在客户端中请求：“请使用 Frely 工具列出这个工作区的顶层文件与目录名称，不写文件，不执行 Shell。”
5. 收到真实工具结果，并与所选文件夹核对一致，才算完成首次连接。`frely doctor` 通过、显示 MCP URL 或保存连接记录都不能替代这一步。

若希望使用用户主目录 `~`，登录后可以直接执行 `frely mcp url`，省略第 2 步。尚无 MCP 配置时，它等价于 `frely mcp setup --workspace ~`：展示主目录、请求浏览器批准（默认 90 天），批准后安装后台服务，再输出 URL。已有配置保留原工作区；过期授权仍需 `frely mcp renew`，凭据损坏等错误不会触发重新 setup。初始化提示写入 stderr，stdout 只包含 URL 或 `--json` 的 JSON；批准或服务安装失败时不输出成功结果。

调用失败时运行 `frely doctor` 查看概览，再用 `frely doctor -v` 查看诊断细节；同时确认客户端 OAuth 授权已经完成、设备在线。授权到期按下文续期。没有合适的远程客户端时，可以先阅读代码与文档，不把“安装完成”记录成“连接成功”。

## 产品定义与入口

FrelyMCP 的产品定位是：**让 Agent 从任何地方访问你的设备。** 用户在目标电脑运行 Frely CLI，由网页中的 Agent，或另一台电脑上的 Codex、Claude Code 等命令行 Agent，通过远程 HTTP MCP 和 OAuth 访问文件、Shell 和进程工具。设备通过出站连接接入 Relay，无需开放公网端口；执行发生在目标电脑。调用端无需安装 Frely CLI。

这里的 Agent 是访问设备的外部客户端。CLI 调用 Frely 托管 Agent 是另一条调用方向，其 install/invoke 命令包含在 npm 0.6.2 中。设备访问无需配置托管 Agent 调用或 Provider 模型共享。

- Web：Frely → **Device MCP**，路径保持 `/user/account/connections`。展示设备、工作区、执行权限与到期时间，复制连接 URL 或 Claude Code 命令，撤销设备或 MCP 权限。
- CLI：`frely mcp` 启用，`frely mcp url` 获取地址，`frely mcp renew` 续期，`frely mcp revoke` 撤销。状态和诊断统一使用 `frely doctor [-v]`。
- Landing：以 Agent 从外部访问用户设备为主线，网页 Agent 与命令行 Agent 是接入场景；主标题为“让 Agent 从任何地方访问你的设备”。中英文保持同一能力边界，避免副词。独立功能无步骤编号；页面不展示写死的产品版本或发行状态。
- 兼容：`frely mcp setup` 和 `frely mcp chatgpt` 保留；后者只展示同一服务的 URL/OAuth 信息，不是独立通道。
- `frely mcp url --json` 返回 `deviceId`、`mcpUrl`、`transport=http`、`authentication=oauth`、`workspace` 和 `expiresAt`；新增字段不改变原 URL。

设备列表的 Last connected 是历史时间，不代表当前在线。在线状态在被控电脑用 `frely doctor` 检查；客户端 OAuth 与真实工具调用需要单独验证。

## Codex 跨电脑接入

在目标电脑安装并启用设备 MCP，运行 `frely mcp url`。在运行 Codex 的另一台电脑中添加该地址：

```sh
codex mcp add frely-computer --url "<MCP_URL>"
```

按提示完成 OAuth 授权；需要发起授权时执行：

```sh
codex mcp login frely-computer
```

以上命令语法由本机 Codex 的 `mcp add --help` 和 `mcp login --help` 核对。每台目标设备使用不同的服务名称。让 Agent 使用 Frely 的 `workspace_info` 与 `list_directory` 核对目标设备；命令行 Agent 自带 Shell 在调用端电脑执行。本次配置文档核对不等于新建 OAuth 连接或真实调用验收。

## Claude Code 跨电脑接入

在电脑 A 安装并启用设备 MCP，运行 `frely mcp url`。在电脑 B 的 Claude Code 中添加 A 的地址：

```sh
claude mcp add --transport http frely-computer-a "<电脑 A 输出的 MCP URL>"
```

在 Claude Code 中打开 `/mcp`，完成 OAuth 授权。调用端登录设备所有者的 Frely 账号。要求 Agent 使用 Frely 的 `workspace_info` 与 `list_directory`，核对返回的路径和文件名属于电脑 A。Agent 自带的 Shell 默认仍属于电脑 B，任务说明应明确使用远程 Frely 工具。

参考：[Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。这里只说明接入配置；真实客户端的 OAuth、调用与续期验证不能由源码或单测替代。

## 多客户端运行规则

同一设备的远程客户端共享工作区、MCP runtime 和受管进程；它们是同一所有者对自己设备的多个入口，不提供客户端间的文件或进程隔离。请求 ID 由 Relay/CLI 映射，避免不同客户端复用 JSON-RPC ID 导致串线。进程工具中的 runtime 指这一共享运行时；连接重建会结束受管运行态。

设备 MCP 执行权限被撤销或到期后，所有客户端都不能继续执行；撤销某个 OAuth connection 只阻断该授权连接后续调用，不宣称回滚已有副作用。请求超时或断开不证明命令未执行，不自动重放结果未知的命令。多个 Agent 修改同一仓库应按已有锁、独立 worktree 或任务协调规则安排。

当前范围是同一账号访问自己的设备。跨账号分享、客户端独立进程隔离和完整客户端管理列表属于后续能力，不能由当前设备列表推断已实现。

## 产品边界

基础层包含账号会话、Network、Provider、远程 Agent Skill 与基础诊断，不依赖本机 MCP 执行授权。当前 CLI 版本如果提供 `frely skill install`、`frely agent invoke` 等命令，它们属于**当前实现 surface**，不是 Agent Skill 永久硬编码的协议。Creator Agent 的长期机器自描述入口固定为 `frely help --agent --json`：Client Skill Adapter 应先读取该 JSON，再使用当前版本声明的 exact-version Agent lookup/install/invoke、认证、key/budget、login/topup/authorization 等能力。这条路径不修改宿主的模型 Provider/Base URL，也不启用本机文件、Shell 或进程权限。消费者可以使用账号会话，也可以使用 Creator/用户提供的 Agent Delegated Key；Delegated Key 的目标限制由 Agent AP + 受限 Plan source + API-key Plan-source restriction 表达，`$10` 等金额是 direct Key 的最大累计服务消费 hard limit，不是 prepaid balance，也不要求新增 `allowedModel`。Raw caller key 若由 CLI 导入必须进入系统安全凭据库，不写入 Skill、argv 或普通配置；Agent Runtime Key 永远只存在于 Frely/Swarm 服务端，不能被 CLI 导入、显示或覆盖。

本文件其余 `frely mcp` 内容只描述本机工具共享。MCP 层提供本机文件、Shell、进程与工具执行能力，需要独立授权。调用云端 Agent/MCP 服务不等于授权外部主体控制本机。远程 Agent 的 trigger metadata 和 manifest 绑定精确 Agent version；创建 Agent 后不再要求 Creator 走第二条独立 Create Skill 产品主链。

Relay 负责设备身份、MCP 授权、OAuth、连接、请求转发和撤销。CLI 负责本机执行、工作目录、调度与进程生命周期。项目不创建独立 `friday-local` runtime。

Cloudflare Worker + Durable Objects 数据面迁移方案见 [Device Transport](device-transport.md)。方案保留 Relay 作为备用 transport；公网 MCP URL 与 `frely.device-relay.v1` 不变。

## 安装

仓库提供 `install.sh` 与 `install.ps1`。安装器下载独立程序，校验 SHA-256，写入用户目录，不要求 Node.js、npm、管理员权限或密钥配置。公开入口依赖 GitHub Release 中对应的平台程序与校验文件；tag 发布流程负责生成这些资产。

源码构建与验证：

```sh
npm ci --ignore-scripts
npm run build:standalone
npm run test:standalone
npm run test:installer
```

开发者可使用 npm 分发，运行环境要求 Node.js 22 或更高版本。此源码不依赖 keytar。

## 基础账号

```sh
frely login
frely whoami
frely doctor
frely network status --json
```

`login` 使用浏览器设备授权，客户端为 `frely-cli-basic`。会话存储采用用户私有目录中的明文文件。文件权限限制其他用户读取，不提供静态加密保护。基础令牌不具有 Owner、账号安全管理、密钥导出或 MCP 批准权限。

旧 Cookie 和旧高权限会话不迁入基础文件。升级需要基础账号登录。旧设备、Provider 绑定可能需要重建；CLI 不把旧设备私钥复制到基础存储。

## MCP 启用与续期

```sh
frely mcp
frely mcp --workspace /path/to/project --days 90
frely mcp renew --days 180
```

`frely mcp` 是启用入口，工作目录取当前目录；`--workspace` 指定目录，`--days` 指定授权天数。`setup` 保留兼容命令形式。`frely mcp --help` 提供本功能帮助，`frely doctor` 提供状态概览，`frely doctor -v` 提供诊断细节。

启用流程检查 MCP 安全存储，创建独立 MCP 执行密钥，保存密钥，再展示浏览器批准地址。批准页面显示设备、公钥指纹、工作目录、执行能力和授权天数。用户确认后，服务端记录批准时间与到期时间，CLI 配置用户级服务并输出稳定 MCP URL。

默认期限为 90 天，允许 1—180 个整天。起算点是服务端批准时间。普通令牌刷新、OAuth 刷新、服务重启、升级、重复批准和重复 setup 不延长期限。续期创建新授权和新 MCP 执行密钥，新期限从本次批准时间起算。

续期不改变 MCP URL。OAuth connection 与 MCP 执行授权属于两个生命周期。

Windows 服务使用当前登录用户的 Task Scheduler 任务；macOS 使用 LaunchAgent；Linux 使用 systemd user service。没有用户服务管理器的环境可由部署方托管前台进程。Windows 原生运行结果不由适配器单元测试替代。

## 添加到远程客户端

ChatGPT、另一台电脑上的 Claude Code 和其他支持远程 HTTP MCP + OAuth 的客户端使用同一个设备服务。被控电脑安装 frely-cli；调用端不要求安装 frely-cli。每台设备使用独立 URL，客户端内的服务名称也应区分设备。

```sh
frely mcp url
```

URL 形态：

```text
https://connect.frely.cloud/mcp/<device-id>
```

URL 是 Relay 返回的 canonical MCP resource，不从 `app.frely.cloud` 或其他控制面地址推导，也不包含 bearer secret。客户端 Authentication 选择 `OAuth`。

远程客户端通过 OAuth 2.1 Authorization Code + PKCE 获取访问令牌。访问令牌绑定精确 MCP resource URL。OAuth refresh 不延长 MCP 执行授权。

授权判断：

```text
OAuth access token active
AND OAuth connection resource == MCP URL
AND MCP execution authorization active
AND device connected
=> execute
```

OAuth Token 无效属于 HTTP 认证错误。MCP 执行授权到期属于应用层授权状态，不触发 OAuth 重连。用户执行 `frely mcp renew` 并完成批准后，原 MCP URL 和原 OAuth connection 可继续使用。

Relay OAuth 契约见 [mcp-oauth-relay-contract.md](mcp-oauth-relay-contract.md)。

## 状态、撤销与故障

```sh
frely doctor
frely doctor -v
frely mcp revoke
```

`frely doctor` 读取本地配置、账号摘要、设备权限、后台服务及近期连接心跳；`-v` 进一步检查安全凭证和服务端授权。未启用 MCP 属于可选状态。旧 `mcp status`、`mcp service status` 与 `doctor --mcp` 仅保留兼容，不作为新的用户入口。

授权到期后，Relay 拒绝本机执行请求；CLI 在排队任务开始前检查期限，取消 MCP 请求并关闭受管进程。Provider 身份与服务保留。MCP 存储不可用时，基础功能可用，连接可保留 Provider 能力。

`revoke` 只撤销 MCP 执行授权，不撤销共享 Provider 设备，不卸载共享服务，不代表删除远程 OAuth connection。远程客户端连接撤销属于 OAuth connection 操作。

账号 `logout` 删除基础会话并尝试停止服务；它不等于撤销服务器上的 MCP 授权记录或远程 OAuth connection。

批准请求有效期为 15 分钟，每个用户最多保留八个未到期请求。中断启用后可重试；当前实现不跨进程恢复未完成的批准轮询。

## 存储与部署

MCP 使用系统主密钥加 AES-256-GCM 文件。macOS 对接 Keychain，Windows 对接 Credential Manager，Linux 对接 Secret Service。无桌面环境可使用外部主密钥模式。基础功能不依赖这些组件。

MCP 安全存储包含本机执行私钥与授权元数据，不包含远程 OAuth access token、refresh token 或 MCP URL secret。

服务定义只保存配置目录和存储模式，不保存外部主密钥。部署方必须向服务进程注入 `FRELY_CREDENTIAL_KEY`；交互终端中的环境变量不等于后台服务凭证配置。密钥丢失不会触发明文回退或覆盖原密文。

部署顺序是数据库迁移、Web MCP 批准接口、OAuth Authorization Server、OAuth MCP ingress、Device Relay 强制校验、CLI。旧私有 MCP URL 不获得 OAuth 权限。混合版本不属于已验证部署。

## 本机执行边界

文件工具限制工作目录，拒绝链接逃逸，实施大小限制与原子写入。Shell 使用 CLI 所属系统用户权限；workspace 不是 Shell 沙箱。

到期与撤销不撤回完成的文件修改，不回滚外部副作用，也不承诺回收任意程序脱离受管进程集合后留下的进程。系统用户或管理员失陷不属于凭证存储的保护范围。

协议与并发保持 `frely.device-relay.v1`：独立请求 ID、有界 inflight、读取并发、写入队列、取消与背压。MCP 请求增加授权 ID；Provider 请求不需要该字段。执行结果未知的写入或命令不得重放。

配置、发布签名、迁移限制和测试入口见 [credential-storage.md](credential-storage.md)。
