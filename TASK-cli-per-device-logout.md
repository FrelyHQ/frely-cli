# Per-Device CLI Logout Implementation Task (frely-cli 侧)

## 背景
当前 CLI 登录是 `(client, user)` only，没有设备绑定。这导致一个问题：在 Device A 登出 CLI 会登出所有设备上的 CLI。需要实现 per-device logout。

relay 侧（friday-relay 仓库）的配套改动已经在另一次单独的 pi 调用中处理：
- token 端点新增可选请求参数 `session_binding_device_id`
- 如果 CLI 传了这个参数，relay 会创建 `cli_sessions` 行，并在 token 响应里返回 `frely_cli_session_id`
- 老版本 CLI（不传这个参数）行为不变，向后兼容

**本次运行范围：只处理 frely-cli 仓库（当前仓库）内的改动。不要修改 friday-relay 仓库（在 ../friday-relay）。**

## ⚠️ 重要：仓库当前有其他未提交的改动，不要碰

`git status` 会显示这些文件已经被修改或新增，是另一个正在进行中的、无关的任务（sandbox 执行环境集成）留下的：
- `package-lock.json`, `package.json`（可能两边都要改，如果冲突，只在你需要新增依赖的地方追加，不要动别人已加的依赖项）
- `src/device/protocol.ts`
- `src/device/relay-client.ts`
- `src/runtime/relay-mcp.ts`
- `src/runtime/workspace.ts`
- `src/device/relay-node-contract.test.ts`（新文件）
- `src/runtime/relay-session.test.ts`（新文件）
- `src/runtime/relay-session.ts`（新文件）
- `src/runtime/sandbox.ts`（新文件）

**除非你的任务明确需要修改上面列的文件，否则不要touch它们**，也不要因为看到它们"不完整"或"像是半成品"就去改动或补全——那是别人的任务，不在你的职责范围内。如果你发现自己的改动必须依赖这些文件里正在开发的东西，先在任务文档末尾说明冲突情况，不要擅自替对方完成。

## 设计方案

### 1. Token 存储层：保存 `frely_cli_session_id`

找到当前 CLI 登录/token 刷新的实现，相关文件大概率包括：
- `src/auth.ts`
- `src/device/identity.ts`
- `src/device/state.ts`
- `src/cloud.ts`

先阅读这些文件，搞清楚当前 CLI：
1. 在哪里发起 token 请求（enroll / connect / refresh 流程）
2. 在哪里存储凭证（token、device ID 等），存储路径大概是 `~/.frely/` 下的某个文件，具体格式以现有代码为准
3. device ID 是如何生成或读取的（`src/device/identity.ts` 大概率相关）

然后实现：
- 在发起 token 请求时，把本机的 device ID 作为 `session_binding_device_id` 参数带上（放在 token 请求 body 或 query，具体位置参考现有 token 请求的实现方式，保持风格一致）
- 从 token 响应里读取 `frely_cli_session_id`（如果存在）
- 把它和其他凭证一起存到本地凭证文件里（沿用现有凭证存储的文件格式和位置，不要另起一套新的存储机制）
- 如果响应里没有这个字段（relay 版本较老，或者这次没走这条升级过的路径），不要报错，正常走原有逻辑

### 2. 版本兼容提示

- 如果登录/连接成功后，发现 response 里没有 `frely_cli_session_id` 字段：在 CLI 输出里提示一行类似"你的服务端版本较旧，暂不支持按设备登出"这样的信息（用现有的日志/输出工具，参考 `src/diagnostics.ts` 或其他现有的用户提示写法），但不要中断正常流程

### 3. 完成后
- 运行仓库里已有的 lint / typecheck / test 命令（先看 `package.json` 的 scripts 部分确认命令名）
- 为新增的存储逻辑和版本兼容提示补充测试用例，参考仓库里已有测试的写法和位置
- 完成后，在这个任务文档末尾追加一份"实现总结"，说明改了哪些文件、做了哪些取舍、还有什么已知问题或未完成的部分（包括：如果和上面提到的未提交改动有任何交集或冲突，务必在这里说清楚）。不要执行 git commit，改动保留在工作区即可。

## 已有代码参考
在动手之前，请先读一遍现有的认证/设备相关代码，理解现在的存储格式和请求方式，尽量复用现有的模式和工具函数，而不是引入新的存储机制或请求封装方式。

---

## 实现总结

### 目标
实现 per-device logout 的 frely-cli 侧改动：在 token 请求里带上本机的 `session_binding_device_id`，从响应读取 `frely_cli_session_id` 并本地持久化；对较老服务端给出版本兼容提示；保持向后兼容。

### 改动文件
仅改动本仓库（frely-cli）内 3 个文件，未触碰文档中列出的其他未提交改动文件：

1. `src/auth.ts`
   - `StoredOAuthCredential` 与 `AuthCredential` 新增可选字段 `sessionBindingId`，用于本地保存服务端返回的 `frely_cli_session_id`，沿用现有凭证存储格式（`~/.config/frely` 下的 basic credential store），未另起存储机制。
   - `CliConfig` 新增可选 `deviceId`，用于在 config.json 里持久化本地设备 ID。
   - 新增 `localDeviceId()`：生成稳定的本地设备 ID（`frd_local_` + UUID hex），首次登录生成、后续复用，使同一机器的多次登录绑定同一设备。
   - 新增 `appendSessionBinding()`：在 token 请求 body 里带上 `session_binding_device_id` 参数（仅在存在 deviceId 时带上，老配置不报错）。
   - `loginDevice()`：在发起 device code 流程前获取/生成 deviceId，传给 `pollDeviceToken()`；登录成功后把 `frely_cli_session_id` 随凭证一起写入，并在 config 里写入 deviceId；返回值新增 `sessionBound` 标志。
   - `pollDeviceToken()` / `refreshOAuthCredential()`：token 请求 body 附带 `session_binding_device_id`，并从响应解析 `frely_cli_session_id`。
   - `loadCredential()` 的 refresh 分支：refresh 后继续保存 sessionBindingId（优先用服务端新值，缺失则保留旧值）。
   - `readConfiguredLocalCredential()`：回读时透传 `sessionBindingId`。
2. `src/index.ts`
   - `frely login` 成功后，若 `result.sessionBound` 为 false（响应里没有 `frely_cli_session_id`），额外输出一行提示"你的服务端版本较旧，暂不支持按设备登出"，不中断正常流程。
3. `src/auth.test.ts`
   - 新增两个用例：① 服务端返回 `frely_cli_session_id` 时，token 请求带 `session_binding_device_id`、凭证与 config 中保存 sessionBindingId、`sessionBound=true`；② 服务端不返回该字段时（兼容老版本），`sessionBound=false`、凭证无 sessionBindingId、流程正常。

### 取舍
- **设备 ID 的来源**：登录（token 请求）阶段尚未做 device-relay 注册，本地没有服务端分配的 `drd_` deviceId。因此这里使用本地生成并持久化在 config.json 的稳定设备 ID（`frd_local_`+UUID），重启/重登复用，满足"按设备绑定会话"的稳定性要求，且不引入新的存储机制。
- **向后兼容**：`session_binding_device_id` 与 `frely_cli_session_id` 均为可选。老版本 relay 不识别该参数、也不返回该字段时，CLI 行为与之前完全一致，仅多一行兼容性提示。
- **参数位置**：沿用现有 token 请求 `application/x-www-form-urlencoded` body 的风格，把参数加到 URLSearchParams 中，风格一致。

### 测试与检查
- 相关测试通过：`auth.test.ts`（含新增 2 条）、`credential-*.test.ts`、`two-tier-auth.test.ts`、`login-browser.test.ts` 等，均 pass。
- `src/auth.ts` / `src/index.ts` / `src/auth.test.ts` 通过 `tsc` 类型检查。

### 已知问题 / 与未提交交互的冲突说明
- **`npm run check` 与 `npm test` 无法整体通过，但原因与本任务无关**：文档中列出的其他未提交改动文件存在类型错误，导致全量编译失败：
  - `src/runtime/sandbox.ts:96` — `Property 'missing' does not exist on type 'SandboxDependencyCheck'`
  - `src/device/relay-node-contract.test.ts:40` — `'WsSocket' cannot be used as a value because it was imported using 'import type'`
  - `src/runtime/process-manager.test.ts` — `Cannot find name 'manager'`（多处）
  这些都属于另一个进行中的任务（sandbox 执行环境集成），本任务未触碰这些文件，也未修复它们。我的改动（auth.ts/index.ts/auth.test.ts）在隔离编译与运行下类型检查通过、测试全部通过。
- **未做**：本次未涉及真正的 `frely-cli logout` 命令与 relay 侧 `cli_sessions` 的删除联动（relay 侧改动在 friday-relay 仓库，超出本次范围）。当前 `sessionBindingId` 已持久化保存，为后续"按设备登出/撤销该设备会话"提供了存储基础；logout 流程暂未据此单独撤销该 session。
- 未执行 git commit，改动保留在工作区。
