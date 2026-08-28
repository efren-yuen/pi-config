---
name: cbm
description: 用 codebase-memory-mcp CLI 做代码检索与理解。需要定位符号、追调用关系、看模块架构、评估变更影响或确认索引覆盖时使用；在 grep/find 之前先考虑它。
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
- 默认输出就是精简 JSON，不要加 `--json`（那是 MCP 包装格式，更占 token）。
- flag 是 kebab-case（`--name-pattern`、`--semantic-query`、`--file-pattern`）。**参数不确定时先跑 `codebase-memory-mcp cli <工具> --help`**，不要猜。
- 想省掉每条命令几秒的冷启动：`codebase-memory-mcp daemon start`（`daemon status` 查状态）。

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

- CBM 是 best-effort 索引。看到 `parse_partial`、`skipped`、`not_indexed`、覆盖范围不明或空结果时，**必须**用 `read`/`grep`/`find`/`ls` 兜底核实，不得据此断言代码或文件不存在。
- 报告结论时说明用了哪些查询、有哪些覆盖缺口，不要编造没跑过的查询。

## 非交互模式下的命令写法

subagent 的权限网关按引号解析命令：参数里出现 `|`、`*`、`?`、`#`、`!` 时必须**用单引号包起来**，否则整条命令被拒。

```bash
codebase-memory-mcp cli search_code --project ai --pattern 'foo|bar' --regex true
codebase-memory-mcp cli search_graph --project ai --file-pattern '*.java'
```

`$`、反引号、`;`、`|` 作为 shell 语法（引号外）一律被拒——不要拼管道、重定向或命令替换，需要过滤就用工具自己的 `--limit` / `--path-filter`。
