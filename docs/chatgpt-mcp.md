# Frely CLI 与 ChatGPT MCP

状态：两层授权 + 稳定 MCP URL + OAuth 契约，未发布。

## 产品边界

基础层包含账号会话、Network、Provider 与基础诊断，不依赖 MCP 凭证库。MCP 层提供本机文件、Shell、进程与工具执行能力，需要独立授权。调用云端服务不等于授权外部主体控制本机。

Relay 负责设备身份、MCP 授权、OAuth、连接、请求转发和撤销。CLI 负责本机执行、工作目录、调度与进程生命周期。项目不创建独立 `friday-local` runtime。

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
frely mcp setup --workspace /path/to/project --days 90
frely mcp renew --days 180
```

`frely mcp` 是启用入口，工作目录取当前目录。`setup` 保留兼容命令形式。

启用流程检查 MCP 安全存储，创建独立 MCP 执行密钥，保存密钥，再展示浏览器批准地址。批准页面显示设备、公钥指纹、工作目录、执行能力和授权天数。用户确认后，服务端记录批准时间与到期时间，CLI 配置用户级服务并输出稳定 MCP URL。

默认期限为 90 天，允许 1—180 个整天。起算点是服务端批准时间。普通令牌刷新、OAuth 刷新、服务重启、升级、重复批准和重复 setup 不延长期限。续期创建新授权和新 MCP 执行密钥，新期限从本次批准时间起算。

续期不改变 MCP URL。OAuth connection 与 MCP 执行授权属于两个生命周期。

Windows 服务使用当前登录用户的 Task Scheduler 任务；macOS 使用 LaunchAgent；Linux 使用 systemd user service。没有用户服务管理器的环境可由部署方托管前台进程。Windows 原生运行结果不由适配器单元测试替代。

## 添加到远程客户端

```sh
frely mcp url
frely mcp chatgpt
```

URL 形态：

```text
https://app.frely.cloud/mcp/<device-id>
```

URL 是稳定资源标识，不包含 bearer secret。客户端 Authentication 选择 `OAuth`。

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
frely mcp status --json
frely doctor --mcp
frely mcp revoke
```

`status` 读取本地公开元数据，不访问凭证库，不证明服务端授权状态。`doctor --mcp` 检查安全凭证和服务端状态。基础 `doctor` 将未启用 MCP 视为可选状态。

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
