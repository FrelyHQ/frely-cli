# 发版入口

每个独立发版单元使用独立命令。命令入口与执行位置分开：
服务默认在开发机执行；CLI、MCP 包及独立 Landing 的命令默认提交 tag，由 Actions 执行。
本仓库统一使用 `./scripts/`，不保留旧目录兼容入口。脚本用途见 [脚本目录](../../scripts/README.md)。

| 仓库 / 发版单元 | 命令 | 默认执行 | Actions 请求 tag |
| --- | --- | --- | --- |
| Frely 服务 | `./scripts/release` | 开发机 | `deploy/frely-eu/vX.Y.Z` |
| Frely Landing | `./scripts/release-landing` | Actions 构建，开发机治理入口部署 | `deploy/frely-landing/vX.Y.Z` |
| Network 服务及镜像内的 Landing | `./scripts/release` | 开发机 | `deploy/frely-network/vX.Y.Z` |
| Network frely-mcp 包 | `./scripts/release-mcp` | Actions | `mcp/vX.Y.Z` |
| Swarm | `./scripts/release` | 开发机 | `deploy/frely-swarm/vX.Y.Z` |
| CLI npm、二进制及安装器 | `./scripts/release` | Actions | `vX.Y.Z` |
| CLI Landing | `./scripts/release-landing` | Actions / GitHub Pages | `landing/vX.Y.Z` |

Frely 服务包含 cliproxy-egress、cliproxy-control、gateway-srv、web、admin、db-ops 六个自有镜像，
按现有 manifest 作为一组发布。CPA 是外部依赖，不在本仓库构建。
CLI 包、八个平台二进制、各自 SHA-256 与 install.sh / install.ps1 使用同一个版本。
Network 的 apps/site 当前随服务 Docker 镜像构建与部署，尚无独立静态站点部署目标；
Explorer 与开发示例也没有生产发布目标。它们不能被计为已经具备独立部署能力的 Landing。

以上为跨仓库发布单元概览；本仓库仅包含 CLI 与 CLI Landing。
本仓库通过 `--validate-tag` 校验发布身份，实际发布由 Actions 完成，不提供 `--from-tag` 本地执行入口。

## 从命令发版

在相应仓库的干净 main 上执行：

```bash
./scripts/release --list
./scripts/release --dry-run
./scripts/release --version 1.2.3
```

主服务切换至备用 Actions 路径：

```bash
./scripts/release --executor actions --version 1.2.3
```

独立 Landing：

```bash
./scripts/release-landing --dry-run
./scripts/release-landing --version 1.2.3
```

Frely Landing 保留开发机备用执行：

```bash
./scripts/release-landing --executor local --version 1.2.3
```

本仓库 CLI 与 Landing 只支持 Actions 执行。其他仓库的本地执行入口见各自文档。
CLI 包命令继续使用原有的版本更新、检查、提交、推送和等待 Actions 的流程。
`--no-wait` 可关闭 CLI 包的工作流等待。

没有给出版本时，通用入口取该发布单元已知稳定 tag 的下一个 patch；
首次静态发布使用 0.1.0。MCP 包的 tag 必须与 apps/frely-mcp/package.json 一致：
首次可用现有包版本；后续先修改包版本、更新 bun.lock 并提交，再运行
`./scripts/release-mcp --version X.Y.Z`。CLI 命令自动更新自身 package.json/package-lock.json。
版本支持稳定版及 SemVer 预发布，不接受 build metadata。预发布包应使用 npm 的 next 通道。

通用 Actions 提交命令输出 `RELEASE_PLAN_JSON`；推送 tag 只代表已提交发布请求，
最终结果以工作流中的发布、部署和验证为准。`--dry-run` 不创建或推送 tag、
不构建或部署，但可 fetch 远端引用用于身份校验。

## 手动 tag 入口

先保证提交已经在 origin/main。选择上表中对应制品的 tag：

```bash
git tag -a deploy/frely-landing/v1.2.3 <完整提交SHA> -m "Frely Landing 1.2.3"
git push origin refs/tags/deploy/frely-landing/v1.2.3
```

必须使用 annotated tag。工作流验证 tag object、远端 peeled commit、检出 HEAD、
main 历史及工作流所属制品。npm tag 还验证 package.json 版本。
工作流不从 annotation 读取任意命令、主机或路径。

Actions 请求 tag 与本地发布记录 tag 分离：
服务本地的 `release/...`、Frely Landing 本地的 `landing/frely-cloud-eu/...`
不会再次触发部署。CLI 的 `v...` 仅发布 CLI；`landing/v...` 仅发布 CLI 站点。
CLI 站点不再随 main 的文件变动自动上线，这是本次发布行为变化。

失败时保留原 tag。先检查工作流结果与已产生的 manifest/镜像；
源码变化必须使用新版本，不移动既有 tag。
支持 workflow_dispatch 的工作流只接受已存在的 tag，可用于重试同一源码；
它仍执行现有发布器的检查，不承诺跳过已完成的外部写入。
Frely 已冻结制品后的 deploy/verify 重试继续使用原发布器的 manifest stage。

## Actions 执行条件

- Frely 服务：仓库中现有 `self-hosted, macOS, friday-release-control` Runner；
  需要开发机的 Docker、Bun 1.4.x、Node、Git/GHCR 身份及 Host Governance。
  备用 Actions 路径由 GitHub 调度，构建仍在开发机。现有发布器尚无托管 Linux Builder profile。
- Frely Landing：ubuntu-latest 构建 immutable bundle；同一开发机 Runner 通过
  Host Governance 部署该 bundle 并验证 frely.cloud marker，不重新构建。
- Network / Swarm：ubuntu-latest；仓库变量 `CTB_EU_SSH_HOST`、`CTB_EU_SSH_USER`，
  secrets `CTB_EU_SSH_KEY`、`CTB_EU_KNOWN_HOSTS`。固定别名为 ctb-eu，并回读
  /etc/deploy/host-id。GHCR 使用 GITHUB_TOKEN；若现有包权限不授予该仓库，
  需要具备对应包权限的 GHCR_TOKEN。目标机继续使用自身的拉取凭据。
- frely-mcp：Network 的 npm environment 中配置 NPM_TOKEN，并确保有 frely-mcp 包发布权限。
- CLI：已有 NPM_TOKEN 用于包发布；Pages 使用 workflow 发布源及 github-pages environment，
  该 environment 需允许 `landing/v*` 类型为 tag 的部署规则，保留既有分支保护规则。
- 各生产 environment 的 reviewer、tag 允许范围与访问规则由仓库管理员维护；
  tag 校验不替代 environment 的部署授权。

2026-09-17 的只读检查确认 Frely 开发机 Runner 在线，CLI 已有 NPM_TOKEN 与 workflow Pages；
Network / Swarm 的上述 SSH 配置以及 Network NPM_TOKEN 尚未配置。
CLI 的 github-pages environment 已添加 landing/v* tag 规则并保留原 main 分支规则。
这些是首次启用对应 Actions 的前置条件，不应把工作流文件存在报告成生产验收通过。

## 验证

`node --test scripts/release-entry.test.mjs` 使用隔离的本地 bare Git 仓库，
验证 tag 路由、dry-run、main 归属、annotated identity 和工作流边界，不连接生产。
`release-entry.yml` 在相关 PR/main 变更时运行这些维护测试。
实际构建、部署、npm 发布和公网 marker 验证由对应发布工作流执行。

## 附注标签的检出

发布校验的 `actions/checkout` 必须显式设置 `ref: ${{ github.ref }}`（手动重试使用对应 tag 输入），并保留 `fetch-depth: 0`。默认检出会携带事件 commit SHA；在附注标签校验不匹配时，其后续 fetch 会把本地 tag ref 指向 commit，造成 `Release tag must be annotated` 误报。push 发布还会校验标签对应提交与 `GITHUB_SHA` 一致。

已经失败的 tag 不重绑到修复提交。发布工作流有修改时使用新版本标签；直接 rerun 旧工作流仍使用旧配置。
