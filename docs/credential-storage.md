# Frely CLI 凭证存储决策

状态：源码实现；发布验收包含三平台 CI。本文不代表 npm 发布完成。

## 决策

移除 `keytar`。不引入替代原生 npm 模块。

桌面方案：系统凭证库保存 32 字节主密钥，AES-256-GCM 文件保存账户令牌、刷新令牌与设备私钥。

无桌面方案：外部 Secret Manager 提供主密钥，AES-256-GCM 文件保存凭证。环境变量是密钥注入接口，不是密钥备份。

安全底线：无明文回退；无“密文与密钥共存文件”；无机器标识派生密钥；无凭证访问失败后的设备私钥重建。

## 平台实现

| 平台 | 系统接口 | 运行条件 |
| --- | --- | --- |
| macOS | `/usr/bin/security`、Keychain | 用户钥匙串可访问；系统授权要求保留 |
| Windows | Windows PowerShell、`CredReadW` / `CredWriteW` / `CredDeleteW` | 用户凭证库可访问；PowerShell 策略允许系统 API 适配器 |
| Linux | `secret-tool`、Secret Service | `libsecret-tools` 或发行版对应包、D-Bus 会话、已解锁的 Secret Service |
| 无桌面环境 | Node.js `crypto` | 外部 32 字节随机主密钥、持久化密文目录 |

安装条件：Node.js 22 或更高版本、npm。凭证模块没有 npm 原生扩展、安装生命周期脚本、Python、node-gyp 或编译工具链要求。Windows 适配器使用系统 .NET 的 `Add-Type`，不需要安装 C++ 工具链。

凭证读写是运行期操作。`--help`、`--version` 不初始化凭证库。CLI 不执行 `sudo`，不安装 Linux 系统软件包，不绕过 Keychain 授权或 PowerShell 管理策略。

## 配置接口

| 配置 | 含义 |
| --- | --- |
| `FRELY_CREDENTIAL_STORE=auto` | 初始模式；存在 `FRELY_CREDENTIAL_KEY` 选择文件模式，否则选择系统模式 |
| `FRELY_CREDENTIAL_STORE=system` | 系统凭证库管理主密钥 |
| `FRELY_CREDENTIAL_STORE=encrypted-file` | 外部主密钥管理文件模式 |
| `FRELY_CREDENTIAL_KEY` | 32 字节随机密钥的 64 字符十六进制编码 |
| `XDG_CONFIG_HOME` | 配置根目录；缺省值为 `~/.config` |

外部密钥模式启动示例，前提是部署环境完成 `FRELY_CREDENTIAL_KEY` 注入：

```sh
export FRELY_CREDENTIAL_STORE=encrypted-file
frely login
frely mcp serve --workspace /path/to/project
```

密钥来源应为部署环境的 Secret Manager 或凭证注入设施。密钥禁止进入代码仓库、Shell 历史、命令参数、日志、启动服务定义或密文目录。密钥必须拥有备份与访问控制；每次启动生成新密钥会造成原有凭证不可读。

系统模式目录为 `frely/system-credentials-v1`；外部密钥模式目录为 `frely/credentials-v1`。系统主密钥标识包含密文目录路径摘要。进程重启、后台服务与交互命令必须使用相同的操作系统用户、配置根目录和存储模式。路径变更需要迁移；目录复制不构成系统凭证库迁移。

`frely mcp setup` 的 launchd/systemd 定义不写入主密钥。外部密钥模式的服务管理器需要密钥注入配置。本实现不提供跨模式迁移或密钥轮换命令；变更模式不迁移旧凭证，也不撤销旧令牌。

## 旧版本兼容

系统模式保留 keytar 的服务、账户标识。macOS 读取区分引用字符串与十六进制字节；Windows 保留 `service/account` 目标名与 UTF-8 数据；Linux 保留 `service`、`account` 属性。

旧凭证读取不删除原条目。凭证更新流程为：写入密文文件，验证读取结果，删除旧系统条目。退出流程删除旧条目与密文条目；删除失败产生错误，配置保留。

设备身份读取失败产生错误，不视作身份缺失。主密钥缺失与已有密文共存产生错误，不生成覆盖密钥。原 keytar 条目拥有访问控制要求，系统授权提示不属于安装失败。

## 完整性与故障处理

文件加密采用 AES-256-GCM、12 字节随机 nonce、16 字节认证标签。关联数据包含服务与账户标识。文件名使用标识摘要，不包含令牌。`vault.json` 验证主密钥，阻止错误密钥添加混合数据。

POSIX 目录使用 `0700`，文件使用 `0600`。读取拒绝符号链接、硬链接、非当前用户所有权与不安全权限。写入使用独占临时文件、文件同步与原子替换。初始化锁协调多进程的主密钥与文件头创建；同一凭证的并发更新不是事务协议。

Windows 不把 `chmod(0600)` 视作 ACL 证明。密文保护依靠认证加密；目录 ACL 与备份访问控制属于部署责任。

`frely doctor` 输出后端名称和故障说明，不输出主密钥、令牌、私钥。凭证库不可用、超时、数据损坏或密钥不匹配产生错误。子进程命令参数不包含凭证，输入使用管道，错误信息不包含系统工具的原始凭证输出。

初始化进程中断可能留下 `.init.lock` 或 `.system-init.lock`。恢复步骤需要确认没有活动初始化进程，核查密文与系统主密钥，再处理陈旧锁。删除锁不能修复密钥丢失或密文损坏。

## 替代方案取舍

| 方案 | 收益 | 代价 | 决策 |
| --- | --- | --- | --- |
| 保留 keytar | 改动少 | 已归档；原生构建与安装脚本依赖 | 不采用 |
| 预编译原生 keyring 包 | 系统 API 封装；较少适配代码 | 平台二进制供应链；缺包、错误语义、迁移兼容性验证 | 备选，不采用 |
| 系统工具加密钥封装 | 无原生 npm 安装要求；保留系统访问控制 | 平台适配代码；Linux 运行条件；系统工具调用开销 | 桌面方案 |
| 外部主密钥加密文件 | 无桌面服务依赖；支持无人值守部署 | Secret Manager 配置、密钥备份与轮换责任 | 服务器方案 |
| 明文文件加权限 | 实现与部署简单 | 文件读取或备份泄漏等于凭证泄漏 | 不采用 |
| 加密文件与密钥共存 | 外观为密文 | 相同读取权限可取得解密材料 | 不采用 |

## 自动化与安全边界

安装与 CLI 启动不依赖凭证库。用户首次 OAuth 授权仍需同意；系统钥匙串锁定可能需要解锁。安全持久化需要系统凭证库或外部主密钥，不能使用明文回退消除该条件。

macOS/Linux 后台服务生命周期属于现有 `service.ts`。Windows 后台服务安装不属于本补丁：`frely mcp setup` 的服务步骤不支持 Windows，Windows 使用 `frely mcp serve` 或用户管理的进程监督器。三平台凭证支持不等于三平台后台服务验收。

本补丁保护 CredentialStore 管理的令牌和设备私钥。设备元数据中的私有 MCP bearer URL 不属于该加密存储；该文件与 URL 需要访问控制。

拥有同一操作系统用户权限的恶意进程、管理员、进程内存读取者和被授权的 MCP Shell 不是该方案的隔离对象。MCP Shell 具有用户权限，工作区路径不构成 Shell 沙箱。高风险部署应使用专用系统用户、受控 MCP 访问、备份保护与磁盘加密；外部密钥环境变量不构成进程隔离。

## 验证入口

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:install
npm run test:credentials
```

`test:install` 使用临时 npm 全局前缀，不替换用户的全局安装。`test:credentials` 使用测试命名空间，创建、读取、删除测试凭证，不读取真实账户。测试覆盖旧凭证兼容、多行与 Unicode、16 KiB 凭证、跨进程持久化和删除。

CI 矩阵为 macOS、Windows、Linux，Node.js 22/24。Linux CI 创建测试 D-Bus 与 Secret Service 会话。单元测试采用内存适配器；单元测试通过不代表原生平台测试通过。

## 上游依据

- keytar 仓库与平台依赖：https://github.com/atom/node-keytar
- Apple security 工具源码：https://github.com/apple-oss-distributions/Security/tree/main/SecurityTool/macOS
- Windows CREDENTIALW 定义：https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw
- Node.js 认证加密接口：https://nodejs.org/api/crypto.html
- libsecret 接口与 Secret Service：https://gnome.pages.gitlab.gnome.org/libsecret/
