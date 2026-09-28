---
name: jev
description: 用 Jev（OpenRouter 上的类型化决策模型）做入口需求分流：接到需求后先跑 `jev triage`，得到任务分类、影响面判断和风险评分，再决定自己直接做、建 todo 还是走 /plan。单次调用约 $0.00003、亚秒级返回。也支持自定义问题（choice/noul/score）。
---

# Jev 需求分流

CLI 在 `/home/efren/.pi/agent/bin/jev`（不在 PATH，用绝对路径）。走 OpenRouter 的
`/api/alpha/decisions` 端点，需要 `OPENROUTER_API_KEY` 环境变量（jev 请求不属于敏感命令，
key 已在环境里时正常可用；未设置时会报错提示）。

## 何时用

**接到一条新需求、还没动手之前**。Jev 不生成文本，只对文本做校准概率判断——
适合把 AGENTS.md 里「靠自觉掂量」的软规则变成一次机器判断：

- 需求是查询/单文件/跨文件/杂务？→ `jev triage`
- 影响面清不清楚？→ triage 里的 `clear_scope`
- 直接实施出错破坏性多大？→ triage 里的 `risk`

不适合：需要读代码确认的事（Jev 只看任务描述文本）、架构方案取舍（超出单跳判断能力）。

## 需求分流（主用法）

```bash
/home/efren/.pi/agent/bin/jev triage '把 utils/date.ts 的 formatDate 改成支持时区参数'
```

输出三个答案 + 路由建议：

- `category`（choice）: query / single_file / multi_file / chore
- `clear_scope`（noul）: 影响面是否清楚
- `risk`（score）: 0=可随手回滚 1=需回归测试 2=影响核心逻辑 3=数据/安全/不可逆

按路由建议行动（顺序即优先级，fail-closed）：

1. **risk ≥ 2.5** → 无论分类是什么，走 /plan，实施前人工确认
2. **category=query** → 自己做完，不起 subagent
3. **category=chore** → 低风险杂务，自己做
4. **category=multi_file 或 clear_scope < 0.5** → 走 /plan，等确认后再 /implement
5. 其余 → 单文件自己做（3 步以上仍按 AGENTS.md 建 todo）

注意：路由建议是决策支持不是免死金牌。Jev 只看任务描述，如果描述本身有歧义
（「顺便把这个也改了」），以你读到的实际代码为准；triage 结果和计划冲突时停下说明。

## 自定义问题（按需）

```bash
/home/efren/.pi/agent/bin/jev ask '{"state":"<待判断文本>","questions":{
  "is_risky":{"type":"noul","instructions":"...","criteria":{"true":"...","false":"..."}},
  "pick":{"type":"choice","instructions":"...","criteria":{"optA":"判据","optB":"判据"}},
  "grade":{"type":"score","instructions":"...","criteria":["档0","档1","档2"]}}}'
```

schema 要点（踩过的坑）：

- 每个问题必须 `type`（`noul`/`choice`/`score`）+ 必填 `instructions` 字符串
- `criteria` 的键必须是字符串：noul 用 `"true"`/`"false"`，choice 用选项名，score 用数组
- 单请求 64k token 上限（state + 最长问题共享 32k），超长 state CLI 会截断
- 加 `--json` 拿原始响应（含 `probabilities` 每选项概率和 `usage` 成本）

## 其他子命令

```bash
/home/efren/.pi/agent/bin/jev -h
```

## 纪律

- 概率是决策支持：阈值只是经验值（0.5/2.5），不要把它当确定性信号向用户断言「Jev 说这是单文件」
- Jev 不可达或超时（默认 15s）就跳过分流，按默认纪律（AGENTS.md）走，不要卡在路由上
- 任务描述里不要带凭据、内网地址等敏感内容——它会被发给 OpenRouter/TypeSafe
