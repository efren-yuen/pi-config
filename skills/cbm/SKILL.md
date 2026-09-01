---
name: cbm
description: 用 codebase-memory-mcp CLI 做代码检索与理解。定位符号或内容用 `search_code` 或文件工具；追调用关系、看模块架构、评估变更影响用图查询。用之前先确认选对了项目、且索引是新鲜的。
---

# CBM 代码检索

入口是本机的 `codebase-memory-mcp cli <工具> [--flags]`，每条命令跑完即退出，不需要常驻服务。

## 基本用法

```bash
codebase-memory-mcp cli list_projects                       # 先拿到 --project 用的项目名
codebase-memory-mcp cli index_status --project <项目名>
codebase-memory-mcp cli search_graph --project <项目名> --query 'update cloud client'
codebase-memory-mcp cli get_code_snippet --project <项目名> --qualified-name <符号全名>
```

- `--project` 几乎所有工具都必填，名字从 `list_projects` 取，不要臆造。
- **`list_projects` 里可能出现多个 `root_path` 相同的项目（同一个仓库被索引成两个名字）。这种情况必须逐个跑 `check_index_coverage` 比较 `indexed_at` 和 `generation_matches`，取新鲜的那个**，不得按名字长短或返回顺序猜。选定后同一轮任务里不要换来换去，并在结论里写明选了哪个、为什么。
- 默认输出就是精简 JSON，不要加 `--json`（那是 MCP 包装格式，更占 token）。
- flag 是 kebab-case（`--name-pattern`、`--semantic-query`、`--file-pattern`）。**参数不确定时先跑 `codebase-memory-mcp cli <工具> --help`**，不要猜。
- 想省掉每条命令几秒的冷启动：`codebase-memory-mcp daemon start`（`daemon status` 查状态）。一轮里要连着跑多条 CLI 时先起 daemon，否则每条都要重新冷启动一次。

## 只读工具（随时可用）

| 工具 | 用途 |
| --- | --- |
| `list_projects` | 列出已索引项目 |
| `index_status` | 项目索引状态、节点/边数、未索引清单 |
| `get_architecture` | 模块/目录级架构概览 |
| `search_graph` | 按 BM25 搜符号，支持 label/名称/文件模式过滤，`--semantic-query` 走语义 |
| `search_code` | 带结构信息的内容搜索，`--mode full` 出源码 |
| `get_code_snippet` | 按 qualified_name 取源码，`--include-neighbors` 带上下游 |
| `trace_path` | 调用链追踪，`--direction` 选上下游 |
| `query_graph` | 直接查图 |
| `check_index_coverage` | 确认某些路径是否真的被索引 |
| `detect_changes` | 变更影响面（可比 base branch） |
| `get_graph_schema` | 图的 label / 关系类型 |

## 写类工具（仅交互模式，需用户确认）

`index_repository`、`delete_project`、`manage_adr`、`ingest_traces` 会改索引或落盘，非交互模式（subagent）下会被权限网关拒绝。需要索引新项目时，交给用户或在交互模式下明确征得同意，不要自作主张跑。

## 纪律

- 动手查之前先做两件事：确认项目名唯一（见上面的重名规则），再用 `check_index_coverage` 确认新鲜度。`index_status` 的 `status: ready` 只说明**解析没报错**，不代表索引跟得上当前代码——`parse_partial`/`skipped`/`not_indexed` 全空也可能是几周前的旧索引。判覆盖看 `check_index_coverage` 的 `generation_matches` 和 `recommended_action`，不要用 `index_status`。
- **BM25 按英文标识符分词，中文业务词命中率为零**，会退化成遍历全图返回垃圾节点（实测：在 4 分钟前刚建好的索引上，`--query '个人 违法 声明'` 返回的是 `mock/user.ts` 里的 404 handler）。从中文需求定位代码请直接用 `search_code` 或 `grep`；图查询留到已经拿到英文符号名、要追调用关系的时候再用。
- `search_code` 走 grep 内核、不依赖图索引，索引陈旧时它依然准确；`search_graph`、`trace_path`、`query_graph` 依赖图，索引不新鲜时结论一律不可信。
- 图查询返回空、而 `search_code` 或 `grep` 能命中同一个符号时，结论是**索引陈旧**，不是代码不存在；后续一律以文件工具为准。
- CBM 是 best-effort 索引。看到 `parse_partial`、`skipped`、`not_indexed`、覆盖范围不明或空结果时，**必须**用 `read`/`grep`/`find`/`ls` 兜底核实，不得据此断言代码或文件不存在。
- 报告结论时说明选了哪个项目、用了哪些查询、有哪些覆盖缺口，不要编造没跑过的查询。

## 非交互模式下的命令写法

subagent 的权限网关按引号解析命令：参数里出现 `|`、`*`、`?`、`#`、`!` 时必须**用单引号包起来**，否则整条命令被拒。

```bash
codebase-memory-mcp cli search_code --project ai --pattern 'foo|bar' --regex true
codebase-memory-mcp cli search_graph --project ai --file-pattern '*.java'
```

`$`、反引号、`;`、`|` 作为 shell 语法（引号外）一律被拒——不要拼管道、重定向或命令替换，需要过滤就用工具自己的 `--limit` / `--path-filter`。
