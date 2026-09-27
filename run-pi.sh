#!/bin/sh
set -e
cd "$(dirname "$0")"
exec pi \
  --provider omlx --model "Ornith-1.5-35B-A3B-oQ6e-mtp" \
  -p \
  --tools read,bash,edit,write,grep,find,ls \
  --name "mcp-multi-workspace" \
  -- "请阅读并完整实现 @TASK-mcp-multi-workspace.md 里描述的所有改动。当前已在一个独立的 git worktree 里（分支 pi/mcp-multi-workspace），只需专心完成这个仓库内的任务，不用担心影响其他工作区或其他未提交的改动。文档里列了需要先读的现有代码参考文件，请先读懂它们的风格和现有逻辑，再按文档里的设计方案动手，不要另创设计。完成所有改动并跑通 npm run build 和 npm test 后，在任务文档末尾追加『实现总结』章节，对照文档里的验收标准逐项说明满足情况。不要执行 git commit。"
