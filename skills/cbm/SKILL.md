---
name: cbm
description: 用 cbm（MCP）做代码检索与理解。中文需求用 `search_code` 定位，拿到英文符号名后用 `trace_path`/`get_architecture` 追关系。用之前先确认选对了项目、索引是新鲜的。
---

# CBM 代码检索

工具是 `mcp__cbm__<工具>`，常驻连接，**不要调用 `codebase-memory-mcp cli`**。
`list_projects`、`search_code`、`trace_path`、`get_architecture` 已声明；其余在 codemode 脚本里调，
正文在 `content[].text`。参数不确定用 `describeTool("mcp__cbm__<工具>")`，不要猜。
多个查询放进一个脚本 `Promise.all`，不要一条一个调用。

## 顺序

中文需求 → `search_code` 或 `grep` 定位 → 拿到英文符号名 → `trace_path`/`get_architecture` 追调用链。
**不要用 `sed` 一页页读源码拼调用链**，那是 `trace_path` 的活。

## 四个坑

- **BM25 按英文标识符分词，中文业务词命中率为零**，`search_graph` 会退化成遍历全图返回垃圾节点
  （实测：刚建好的索引上查「个人 违法 声明」，返回 `mock/user.ts` 的 404 handler）。
  中文需求只用 `search_code`/`grep`。
- **`search_code` 走 grep 内核、不依赖图索引**，索引陈旧时它依然准确；`search_graph`、`trace_path`、
  `query_graph` 依赖图，索引不新鲜时结论不可信。
- **`list_projects` 可能出现多个 `root_path` 相同的项目**（同一仓库索引成两个名字）。逐个跑
  `check_index_coverage` 比较 `indexed_at` 和 `generation_matches`，取新鲜的那个，不得按名字长短猜到。
  选定后同一轮别换来换去，结论里写明选了哪个、为什么。
- **空结果/覆盖不明时用 `read`/`grep`/`find`/`ls` 兜底**，不得据此断言代码不存在。
  `index_status` 的 `ready` 只说明解析没报错，不代表索引跟得上代码——判覆盖看 `check_index_coverage`
  的 `generation_matches`。

## 写类工具

`index_repository`、`delete_project`、`manage_adr`、`ingest_traces` 会改索引或落盘。
`delete_project`/`manage_adr` 会被权限网关拦（交互要确认、非交互直接拒）；其余不会弹窗，但
**不要自作主张跑**——索引一个大仓库要几分钟，先问用户。

## 交给 scout 之前（/plan、/implement）

主 Agent 先做只读预检，职责是判断 CBM 结论可不可信，不是替 scout 检索：
`list_projects` 选项目 → 对 1-3 个关键路径 `check_index_coverage` → 通过才允许 `get_architecture`/`search_code`。
任一步不过就停，把检索整个交给 scout，并写明「索引陈旧/CBM 不可用，未获得可信线索，全部走文件工具」。
交接必须含：所选项目与理由、索引时间与体检结论、实际跑过的查询、已确认的路径/符号、覆盖缺口。
不得编造未跑过的查询，不得为了用 CBM 擅自安装、启动或索引。
