# 仓库脚本

所有维护脚本统一放在 `scripts/`，从仓库根目录运行。

| 用途 | 入口 / 实现 | 说明 |
| --- | --- | --- |
| 构建 | `npm run build` / `clean.mjs` | 清理并生成 dist |
| 单元测试 | `npm test` / `test.mjs` | 编译测试、执行并清理临时输出 |
| npm 安装验证 | `npm run test:install` / `install-smoke.mjs` | 先构建；验证 npm 包安装与启动 |
| 系统凭据验证 | `npm run test:credentials` / `credential-smoke.mjs` | 先构建；使用随机测试命名空间 |
| 独立二进制构建 | `npm run build:standalone -- <target>` / `build-standalone.mjs` | Bun 构建与校验和 |
| 独立二进制验证 | `npm run test:standalone` / `standalone-smoke.mjs` | 先构建对应平台二进制 |
| 安装器验证 | `npm run test:installer` / `installer-smoke.mjs` | 先构建二进制；离线检查安装和校验和拒绝行为 |
| CLI 发布 | `./scripts/release` / `release-entry.mjs` / `release-package` | 版本更新、检查、提交、推送 tag、等待 Actions |
| Landing 发布 | `./scripts/release-landing` / `release-landing.mjs` | 通过共享 release-entry 提交独立 tag，由 Pages 发布 |
| 发布目录 | `release-catalog.mjs` | 定义 CLI / Landing 发布单元 |
| 发布入口验证 | `node --test scripts/release-entry.test.mjs` | 隔离 Git 仓库，不连接生产 |
| 线上站点验证 | `verify-site-release.mjs` | Pages 工作流检查发布 SHA |
| 发布治理钩子 | `release-freeze.mjs`、`release-publish.mjs`、`release-verify.mjs` | 由 `.agents/skills-config/project-governance/release-workflow.json` 引用 |

npm 包安装与独立二进制安装器测试覆盖不同分发方式，均保留。
`release-package` 是 CLI 发布实现，并非兼容脚本。
根目录 `install.sh` / `install.ps1` 是对外分发安装器；`site/build.mjs` 是站点构建实现，保留原位置。

本仓库已移除旧目录软链接、废弃发布转发入口和不可执行的本地 tag 发布入口。使用 `--validate-tag` 校验发布身份，实际发布交给 Actions。

发布约束见 [发布说明](../docs/release-entry/README.md)。
