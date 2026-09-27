# frely-cli 本地多工作区支持（第一阶段：仅本地，不含后端/网页）

## 背景

frely-cli 当前一台设备只能绑定一个工作区：本地只存一份 MCP 授权元数据
（`mcp-authorization.ts` 里的 `McpMetadata.grant.workspace`），`runtime/mcp.ts`
的 `createMcpServer(workspaceInput, options)` 只对一个固定根目录开一个
`Workspace` 实例，所有工具调用（`list_directory`/`read_file`/`run_command`/
`start_process` 等）里的路径参数都是相对这一个根解析的。

现在要支持同一台设备注册多个工作区目录，本地和远程 MCP 客户端都能用、能列
出、能删除。这份任务只做**本地部分**：本地注册表 + CLI 命令 + MCP 工具的多
工作区路径解析。**不要改** friday-relay 仓库、不要碰 OAuth/授权批准流程本身
（`setupMcpAuthorization`/`requireMcpAuthorization` 里的批准/续期/撤销逻辑不
变），网页控制台的可见性是后续阶段的事，这次不做。

## 设计方案（已与用户确认，请按此实现，不要另创设计）

### 1. 本地工作区注册表

新建 `src/runtime/workspace-registry.ts`：

- 存储路径：`join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "mcp-v1", "workspaces.json")`
  （与 `mcp-authorization.ts` 里 `mcpMetadataPath()` 同目录下的兄弟文件，参考
  该文件的写法用 `ensureCredentialDirectory`/`readPrivateFile`/`writePrivateFile`
  同样的私有文件读写方式，保持权限一致）。
- 文件内容：`{ version: 1, roots: string[] }`，`roots` 里全部是 `realpath` 之后
  的绝对路径。
- 导出函数：
  - `listWorkspaces(): Promise<string[]>` — 读取并返回 `roots`（文件不存在时
    返回空数组）。
  - `ensureWorkspaceRegistered(path: string): Promise<void>` — 用于把
    `grant.workspace`（当前唯一的、已批准的工作区）自动补进注册表；如果已经
    在里面就什么都不做。这是"第一个/主"工作区的来源，不需要用户手动 add。
  - `addWorkspace(path: string): Promise<string[]>` — 校验：`realpath` 存在
    且是目录；不能和已有任何一条互相嵌套（新路径是已有某条的子目录，或已有
    某条是新路径的子目录，两种都拒绝，报清楚哪一条冲突）；不能重复。校验通
    过后追加并保存，返回追加后的完整列表。
  - `removeWorkspace(path: string, primary: string): Promise<string[]>` —
    `primary` 是当前 `grant.workspace`（realpath 后）。如果要删的路径
    `realpath` 后等于 `primary`，抛错："Cannot remove the primary workspace
    (<path>). It is tied to the device's MCP authorization; run frely mcp
    revoke instead."。否则从列表里移除（路径不存在于列表里也报错，说清楚未
    注册），保存并返回剩余列表。
- 每个函数各自 `realpath(resolve(input))` 校验输入，参考 `workspace.ts` 里
  `existingPath`/`lexicalPath` 对符号链接、控制字符的检查方式做同等严格度的
  校验（拒绝含 `\x00`-`\x1f`/`\x7f` 控制字符的路径、拒绝符号链接目录）。

### 2. `Workspace`/`createMcpServer` 改成能路由到多个根

现状：`runtime/workspace.ts` 的 `Workspace` 类是单根的（`private constructor
(readonly root: string)`），`runtime/mcp.ts` 的 `createMcpServer` 只 `await
Workspace.open(workspaceInput)` 一次。

改法：

- `createMcpServer(workspaceInput: string, options)` 签名不变（调用方
  `mcp-command.ts`/`index.ts` 不用改），内部改成：
  1. `await ensureWorkspaceRegistered(workspaceInput)`（确保主工作区在注册
     表里）。
  2. `const roots = await listWorkspaces();`
  3. 对每个 root 都 `await Workspace.open(root)`，得到一个
     `Map<string, Workspace>`（key 是 realpath 后的根路径）。
- 新增一个路由函数（建议放在 `workspace.ts` 或新文件
  `runtime/workspace-router.ts`，自行判断哪个更合适，但要有单元测试）：

  ```ts
  // 输入：注册的所有 Workspace 实例、以及某个工具调用传入的 path 或 cwd 原始字符串
  // 输出：命中的 Workspace 实例 + 该工具应该用来解析的"相对路径"
  function resolveWorkspace(
    workspaces: Map<string, Workspace>,
    input: string,
  ): { workspace: Workspace; relativeInput: string }
  ```

  规则：
  - 如果 `workspaces.size === 1`：直接用那一个（唯一）实例，`relativeInput`
    就是原样传入的 `input`（不强制要求绝对路径，行为和今天完全一样，向后兼
    容）。
  - 如果 `workspaces.size >= 2`：
    - 如果 `input` 不是绝对路径（`isAbsolute(input)` 为 false，且不是单独的
      `.`），抛错："Multiple workspaces are registered; give an absolute path
      under one of: <逐行列出所有已注册根>."。
    - 否则找出所有"`input` 落在其根目录内"的已注册根（`realpath` 后用
      `relative(root, input)` 不以 `..` 开头判断，和 `workspace.ts` 里
      `lexicalPath` 同款逻辑）。因为注册表本身禁止嵌套，最多只会命中一个；
      如果一个都没命中，抛错："<input> is not inside any registered
      workspace: <逐行列出所有已注册根>."。
    - 命中后，`relativeInput` 是 `input` 相对该根的相对路径（用于后续复用
      `Workspace` 现有的 `existingPath`/`createPath` 等方法，不用改这些方法
      本身）。
  - `.` 这种默认值（很多工具的 `path`/`cwd` 参数默认值是 `"."`）在
    `workspaces.size >= 2` 时也应该走"不是绝对路径"分支报错，而不是偷偷选一
    个工作区——多工作区时不允许隐式默认到某一个。

- `runtime/mcp.ts` 的 `dispatch()` 函数：所有当前直接调用
  `workspace.xxx(textArg(args, "path", ...))` 的地方（`list_directory`/
  `stat_path`/`find_files`/`search_files`/`read_file`/`read_file_lines`/
  `write_file`/`apply_patch`/`create_directory`/`delete_path`/`move_path`/
  `run_command`（`cwd` 参数）/`start_process`（`cwd` 参数）/
  `processCwd`），改成先用 `resolveWorkspace` 把传入的路径/cwd 解析到具体
  的 `Workspace` 实例和相对路径，再调用该实例对应的方法。
  - `workspace_info` 工具：现在返回 `workspace.info()` 也就是
    `{ root: this.root }`。改成不依赖某个具体 `Workspace` 实例，而是直接返
    回 `{ root: <primary root>, workspaces: string[] }`，`root` 保持是主工作
    区（向后兼容老客户端只看 `root` 字段的用法），`workspaces` 是全部已注册
    根的列表（长度 1 时就是只有 `root` 自己）。
  - `run_command`/`start_process` 的 sandbox 调用（`sandboxCommand(command,
    workspaceRoot)`）：`workspaceRoot` 现在必须是"这次调用解析到的那个
    `Workspace` 的根"，不是固定的某一个根。`ProcessManager.start()` 已经接
    受 `workspaceRoot` 参数（上一个任务加的），调用方只要传对这次解析到的根
    即可，`ProcessManager` 内部不用改。

### 3. 新增 CLI 命令：`frely mcp workspace add|list|remove`

参考 `src/mcp-command.ts` 的 `normalizeMcpArgs`（`action === "service"` 那段
写法）加一段 `action === "workspace"` 的校验分支，和 `index.ts` 里
`command === "mcp" && args[1] === "service"` 那段类似的写法加一段
`args[1] === "workspace"` 的分发：

- `frely mcp workspace add <path>` — 要求已经 `frely mcp` 过（
  `inspectMcpMetadata()` 非空，否则报错 "MCP is not enabled. Run frely
  mcp."），调用 `addWorkspace(path)`，成功后打印新增的路径和当前完整列表。
- `frely mcp workspace list [--json]` — 打印所有已注册工作区，标出哪个是主
  工作区（`grant.workspace`）。`--json` 输出 `{ primary: string, workspaces:
  string[] }`。
- `frely mcp workspace remove <path>` — 调用 `removeWorkspace(path,
  metadata.grant.workspace)`，成功后打印剩余列表。

`agent-help.ts` 的 `COMMANDS`/`SHORT_USAGE`/分组（`GROUPS` 里的 "Device MCP"
分组）要把这三个新命令加进去，格式参考同文件里其它 `mcp.*` 条目的写法
（`id` 用 `mcp.workspace.add`/`mcp.workspace.list`/`mcp.workspace.remove`）。

## 现有代码参考（先读懂这些文件的风格，再动手，不要发明新写法）

- `src/mcp-authorization.ts` — 私有文件读写、路径校验、错误信息风格
- `src/runtime/workspace.ts` — `Workspace` 类、`existingPath`/`lexicalPath`
  的路径校验逻辑、`runCommand`
- `src/runtime/mcp.ts` — `createMcpServer`/`dispatch`/工具 schema 声明
  （`tool(...)` 辅助函数）
- `src/runtime/process-manager.ts` — `start()` 的 `workspaceRoot` 参数（上
  一个任务已经加好，不用再改这个文件本身的签名）
- `src/mcp-command.ts` — `normalizeMcpArgs` 里 `action === "service"` 的分
  支写法
- `src/index.ts` — `command === "mcp" && args[1] === "service"` 的分发写法
- `src/agent-help.ts` — `COMMANDS`/`GROUPS`/`SHORT_USAGE`
- `src/mcp-command.test.ts`/`src/runtime/process-manager.test.ts` — 测试风
  格（`node:test` + `node:assert/strict`，不用额外的测试框架）

## 验收标准（完成 = 满足以下全部）

1. `npm run build` 无错误。
2. `npm test` 全部通过（若个别测试因为工具 schema 变化需要更新断言，属于本
   任务范围内，直接更新；但不要删测试来让它"通过"）。
3. 只注册了 1 个工作区时（也就是刚 `frely mcp` 完、还没 `workspace add`
   过），所有现有工具的相对路径/`.` 默认值行为和今天完全一样——写一个测试
   直接证明这一点（比如复用 `workspace.test.ts` 现有的某个用例，确认
   `resolveWorkspace` 单工作区分支不改变结果）。
4. `frely mcp workspace add <合法目录>` 能成功，写入注册表；`add` 一个和已
   有工作区互相嵌套的目录会被拒绝，报错信息里点出具体冲突的是哪一条。
5. 注册 2 个不嵌套的工作区后：
   - 给 `list_directory`/`read_file` 等工具传相对路径或 `.`，报错要求给绝
     对路径。
   - 传落在其中一个根内的绝对路径，能正确路由到那个根并执行成功。
   - 传一个不在任何注册根内的绝对路径，报错列出所有已注册根。
6. `frely mcp workspace list` 能打印出主工作区 + 全部已注册工作区，`--json`
   输出结构如上文所述。
7. `frely mcp workspace remove <主工作区路径>` 报错拒绝（如上文措辞）；
   `remove` 一个非主工作区的已注册路径能成功，且之后 `list` 里看不到它了。
8. `workspace_info` 工具返回的 JSON 里同时有 `root`（主工作区）和
   `workspaces`（全部列表）两个字段。
9. `frely mcp --help`/`frely help --agent --json` 里能看到新增的三个
   workspace 命令。

## 完成后

- 跑 `npm run build` 和 `npm test`，把完整输出（或至少测试统计行）贴进"实现
  总结"里。
- 不要执行 `git commit`。
- 在本文档末尾追加一个"实现总结"章节，逐条对照上面"验收标准"说明每一条的
  满足情况（尤其是有没有偷懒跳过第 3/5 条这种要求写新测试证明行为的部分）。
