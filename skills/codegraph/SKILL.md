---
name: codegraph
description: 用 codegraph 代码知识图谱一次拿到「相关符号的原始源码 + 调用链 + 影响面」。需要弄清楚某功能怎么实现、改一个符号会波及谁、或要在多文件间追调用路径时使用；符号精确定位和编译级正确性仍用 lsp。
---

# CodeGraph 代码图谱

MCP 里以 `codegraph_explore` 暴露（`exposure: direct`，直接在工具列表里）。CLI 在 `/usr/bin/codegraph`，MCP 不可用或需要批量/脚本化时用 CLI，输出与 MCP 工具完全一致。

数据是每个项目自己的 SQLite（`.codegraph/codegraph.db`），由 tree-sitter 从 AST 抽出来的符号和边，**不是 embedding，不做语义检索**。

## 什么时候用它，什么时候不用

| 问题 | 用什么 |
|---|---|
| 「这个功能是怎么实现的」「X 到 Y 怎么走通的」 | `codegraph explore` —— 一次拿全，别再 grep+read 十几轮 |
| 「改这个符号会波及谁」「有没有测试覆盖」 | `explore` 的 blast radius 段，或 `codegraph impact` |
| 「这个符号定义在哪」「谁引用了它」「这改动编译过吗」 | `lsp`（jdtls/clangd 的类型解析比静态解析准） |
| 重载、泛型、接口实现到底选了哪个 | `lsp` |
| 纯文本、注释、配置、日志里的字符串 | `grep` |
| 项目没建索引 / 索引明显过期 | 先 `codegraph init` 或 `codegraph sync` |

两者是互补不是替代：**codegraph 负责「面」（一次拉出跨文件的结构和源码），lsp 负责「点」（同一个符号的确定答案）。**

## 查询怎么写（最容易踩的坑）

**中文查询直接空结果。** 它只做词法匹配，没有中文分词：

```
$ codegraph explore '供应商列表页面如何加载数据'
No relevant code found. Explore matches symbol/file names and indexed code words
lexically, not by meaning.
```

把需求翻成**符号名、英文词、代码里的字面量**再查：

```bash
codegraph explore 'SupplierListModal fetch list'      # ✅
codegraph explore '供应商列表页面如何加载数据'          # ❌ 必空
```

- 中文注释/中文标识符本身是被索引的，能被词法命中；**空的是中文自然语言提问**。
- 一次给 3~6 个词最好：入口符号名 + 它调的方法名 + 领域名词。
- 名字猜错不是灾难：`Not in the index: useSupplierList` 会明说没命中，并给相近结果，不会假装答上了。
- 想知道有哪些符号可查，先 `codegraph query <子串>`（`-k function` 按类型过滤，`-j` 出 JSON）。它是子串模糊匹配，比 `lsp search` 宽松。

## 常用命令

```bash
G=codegraph

$G status                                   # 索引健康度：文件/节点/边数、索引版本
$G query SupplierListModal -l 20            # 找符号（位置清单）
$G explore 'SupplierListModal fetch list'   # 主命令：源码+调用链+影响面
$G node SupplierListModal                   # 单个符号的源码 + 调用者/被调用者轨迹
$G node --file src/pages/x/index.tsx        # 文件模式：带行号全文 + 反向依赖
$G callers fetchSuppliers                   # 谁调了它
$G callees fetchSuppliers                   # 它调了谁
$G impact SupplierListModal -d 3            # 影响面（可 -j）
$G affected src/a.ts src/b.ts               # 改了这些文件，该跑哪些测试
$G files --no-tests                         # 索引里的文件结构，比扫盘快
$G cycles                                   # 循环依赖，有环时退出码 1
```

跨项目查询用 `-p`，不必 cd 过去：

```bash
codegraph explore 'CoscoSupplier page' -p ~/Workspace/project/biz_supplier_manage_master
```

## 索引新鲜度

- 首次：`codegraph init [路径]`（默认索引，`-y` 非交互）。会建 `.codegraph/`，该目录自带 `.gitignore` 把自己挡在 git 外。
- 后续靠后台 daemon 用 inotify 增量同步，正常不用管。
- 判断是否过期看 `codegraph status`，或直接 `codegraph sync`（增量）/ `index`（全量重建）。
- **引擎升级后索引会整体过期**，且 `codegraph_explore` 会在结果最前面警告（实测本机 6 个项目都是 `extraction 24` 建的，运行引擎要 `extraction 28`）。这时 `sync` 不够，得 `codegraph index` 重建；警告里的 `Indexing is the user's decision` 就是叫你先问再动。
- 卡住报锁冲突用 `codegraph unlock`。

## 纪律与代价

- **daemon 每项目常驻约 170MB RSS**，随会话结束退出。项目多时别同时开一堆。
- **索引状态是「上次同步」的快照**。源码刚改完，索引可能还没跟上；`explore` 返回的源码是当场从磁盘重读的，但**边的结构可能滞后一拍**——涉及「刚加的函数谁调用了」这类问题先用 `grep` 兜底。
- **`codegraph install` 不要跑**：它除了写 `mcp.json`，还会往 `AGENTS.md`/`CLAUDE.md` 追加一段 CodeGraph 说明。本机的接线已经手工做过，配置由这份 skill 承担。
- 系统级安装在 `/usr/lib/codegraph/`（自带 node 运行时，root 装的），`codegraph upgrade` 会因权限失败；升级需要 sudo 重装。
- 空结果不等于代码不存在：可能项目没索引、文件在默认跳过目录（`build/`、`dist/`）、或名字拼法不同。用 `read`/`grep` 核实后再下结论，别拿空结果当「不存在」的证据。
