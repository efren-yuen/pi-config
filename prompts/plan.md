---
description: 只读执行 scout → planner，输出计划并等待用户确认，不实施。
---

针对以下需求使用 subagent 工具的 `chain` 参数：$@

在调用 subagent chain 之前，当前主 Agent 先做一次只读 CBM 预检。预检的职责是**判断 CBM 的结论现在可不可信**，不是替 scout 做检索——固定按下面三步走，任一步不过就让 CBM 退场：

1. `codebase-memory-mcp cli list_projects` 拿项目名。**若本仓库出现多个 `root_path` 相同的项目，逐个跑 `check_index_coverage` 比较 `indexed_at` 和 `generation_matches`，选新鲜的那个**，并在预检结果里写明选了哪个、为什么。不得按名字长短或返回顺序猜。
2. 对本次需求最可能涉及的 1-3 个路径跑 `codebase-memory-mcp cli check_index_coverage --project <项目名> --paths '<路径>'`。**禁止用 `index_status` 判覆盖**——它的 `ready` 只说明解析没报错，不代表索引跟得上当前代码。
3. 只有体检通过（`generation_matches: true` 且 `status` 正常）才允许追加查询，且限 `get_architecture` 看架构、`search_code` 做定位。`search_graph` 仅在已知英文符号名、要追调用关系时用；**禁止拿中文业务词喂 `--query`**，BM25 对中文命中率为零，只会返回垃圾节点。

体检不通过、覆盖不明、CBM 不可用或查询返回空 → **立刻停止 CBM，不要再补搜索**，把检索完整交给 scout。纯配置、文档或 CBM 不擅长的内容直接用文件工具。不得为了使用 CBM 擅自安装、启动或索引项目。

`【CBM 预检结果】` 传入 scout，必须包含：所选项目名与选择理由、索引时间与体检结论、实际执行过的查询、已确认的路径/符号（没有就写“无”）、覆盖缺口。CBM 不可用或索引陈旧时明确写“索引陈旧/CBM 不可用，未获得可信线索，全部走文件工具”。**不得把 `index_status` 的 `ready` 当成覆盖完好**，不得编造未执行的查询，不得把空结果当成“代码不存在”——后续由 scout 用 `read`、`grep`、`find`、`ls` 兜底。

然后按以下顺序执行：

1. 调用 `scout`，只读收集所有相关上下文，并结合主 Agent 传入的 CBM 结果做文件级核实。
2. 调用 `planner`，将 scout 输出通过 `{previous}` 传入，生成实施计划；要求 planner 同时考虑 CBM 结果和文件工具核实结果。

只执行这两个步骤，绝不调用 worker、绝不修改文件。返回计划后必须明确等待用户确认；只有用户在后续消息中确认该计划，才可执行 worker。CBM 预检、scout 和 planner 都必须保持只读。此模板仅定义协作流程，不能替代 Pi 的项目信任、权限确认或操作系统安全授权。
