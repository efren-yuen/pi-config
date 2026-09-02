---
name: git
description: 提交代码、查看改动、写 commit message 时使用。包含 pi 权限网关对 git 命令的实际限制——哪些形式会被直接拒绝、多行 commit message 为什么写不进去。
---

# Git

权限网关（`extensions/permission-gate.ts`）对 git 有两条从命令行看不出来的行为。

## 1. commit message 不能带真实换行

网关的 `normalizeCommand()` 会把所有控制字符（含 `\n`）替换成空格，再写回命令本身。所以 heredoc、`-m $'a\nb'`、多行字符串里的换行**全部会被压成一行**。

写多段 message 用多个 `-m`，每个 `-m` 是独立一段：

```bash
git commit -m "Add retry to sync job" -m "Why: upstream 502s were dropping records." -m "Risk: none, retry is capped at 3."
```

## 2. 只有 force push 会被硬拒

`git push --force` / `-f` / `+branch` 直接拒绝，不给确认机会。
其余 git 命令（含 `add`、`commit`、`checkout`、`merge`、`push`）主 Agent 和 subagent 都能跑。

提交仍然建议由主 Agent 做——不是网关限制，是流程上不该让 worker 自己决定提交什么。

## 提交习惯

一次提交一件事，不要把无关改动混进同一个 commit。

message 首行英文祈使句，≤72 字符，不带句号。需要说明原因和风险时追加 `-m` 段落。
