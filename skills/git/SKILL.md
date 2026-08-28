---
name: git
description: 提交代码、查看改动、写 commit message 时使用。包含 pi 权限网关对 git 命令的实际限制——哪些形式会被直接拒绝、多行 commit message 为什么写不进去。
---

# Git

权限网关（`extensions/permission-gate.ts`）对 git 有三条从命令行看不出来的行为，先看这三条。

## 1. commit message 不能带真实换行

网关的 `normalizeCommand()` 会把所有控制字符（含 `\n`）替换成空格，再写回命令本身。所以 heredoc、`-m $'a\nb'`、多行字符串里的换行**全部会被压成一行**。

写多段 message 用多个 `-m`，每个 `-m` 是独立一段：

```bash
git commit -m "Add retry to sync job" -m "Why: upstream 502s were dropping records." -m "Risk: none, retry is capped at 3."
```

## 2. 写操作只有主 Agent 能做

只读查询（status/diff/log/show/branch/ls-files/rev-parse，且选项在白名单内）任何场景都放行。

`add`、`commit`、`checkout`、`merge` 这些会落到网关末尾的交互分支：

- 交互会话 —— 弹一次「Allow once」确认，同意后执行
- subagent（非交互）—— 直接返回 `Denied: non-interactive mode only allows known read-only commands.`

**不要让 worker 或 reviewer 去提交**，提交由主 Agent 做。

## 3. 会被拒的具体形式

硬拒（`terminate: true`，不弹确认）：

- `git push --force`、`-f`、`+branch`

超出只读选项白名单，一律拒：

- `git diff HEAD`、`git diff HEAD~1`、`git diff main...HEAD`、`git diff -- <路径>`
- `git log --oneline -10`、`git show HEAD`

带 revision 或路径参数就会触发。要限定范围时，先 `git diff --name-only` 拿文件清单，再逐个 read。

## 提交习惯

一次提交一件事，不要把无关改动混进同一个 commit。

message 首行英文祈使句，≤72 字符，不带句号。需要说明原因和风险时追加 `-m` 段落。
