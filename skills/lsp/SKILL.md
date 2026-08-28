---
name: lsp
description: 用 lsp CLI 做精确的代码定位和类型检查——跳定义、找引用、看调用层级、查类型签名，以及确认改动有没有引入编译/类型错误。需要「这个符号到底定义在哪」「谁调用了它」「我这次改动编译得过吗」这类确定答案时使用。
---

# LSP 代码智能

CLI 在 `/home/efren/.pi/agent/bin/lsp`（不在 PATH 里，用绝对路径调用）。

语言服务器由常驻 daemon 托管，按 (服务器, 工作区根) 复用。主 Agent 和所有 subagent 共用同一个热实例，所以启动成本整条任务链只付一次。

## 命令

```bash
L=/home/efren/.pi/agent/bin/lsp

$L diag src/main/java/com/example/OrderService.java   # 诊断：类型/编译错误
$L def   src/main.ts --symbol computeTotal            # 跳定义
$L refs  src/OrderService.java --symbol countOrders    # 找引用（跨文件）
$L impl  src/Repo.java --symbol save                   # 找接口/抽象方法的实现
$L hover src/order.ts --symbol computeTotal            # 类型签名与文档
$L callers src/OrderService.java --symbol countOrders  # 谁调用了它
$L callees src/OrderService.java --symbol describe     # 它调用了谁
$L symbols src/order.ts                                # 文件符号大纲
$L search OrderService --file src/App.java             # 全工程符号搜索
$L status                                              # 运行中的服务器
$L servers                                             # 已注册服务器与安装状态
```

## 定位优先用 `--symbol`

所有位置类命令都支持两种定位方式：

- `--symbol <名字>` —— **首选**。自己数行列非常容易错。
- `--line N --col N` —— 行列都是 **1-based**，和 `read` 工具的输出一致。

Java、C/C++ 的方法名在符号表里带签名（`countOrders()`、`addOrder(String)`），`--symbol countOrders` 会自动按左括号前的名字匹配，不用写全签名。符号找不到时报错会把该文件里实际有的符号名列出来。

## 支持的语言

| 语言 | 服务器 | 备注 |
|---|---|---|
| Java | jdtls | 见下面的多 JDK 说明 |
| TypeScript / JavaScript / **Vue** | typescript-language-server | `.vue` 靠 `@vue/typescript-plugin`，`symbols` 对 `.vue` 无效，其余命令正常 |
| Python | pyright | |
| YAML | yaml-language-server | 只有诊断有意义 |
| Lua | lua-language-server | |
| C / C++ | clangd（系统自带） | 需要 `compile_commands.json` 才准 |

没装的用 `lsp install <id>`（**只能交互模式跑**，会下载并写盘）。

## Java 多版本

jdtls 进程固定跑在 JDK 21 上，但**项目用哪个 JDK 编译是另一回事**：本机 8/11/17/21 四套运行时都已声明给 jdtls，它读 pom 的 `maven.compiler.source` 或 gradle 的 `sourceCompatibility` 自动选。Java 8 老项目会正确地把 `var` 报成错误。

**Gradle 老项目的坑**：Gradle < 7.3 跑不在 JDK 21 上，导入会失败。在项目里建 `.pi/lsp.json`：

```json
{ "servers": { "java": { "settings": { "java": { "import": { "gradle": { "java": { "home": "/usr/lib/jvm/java-11-openjdk" } } } } } } } }
```

## 纪律

- **首次对 Java 项目查询会慢**（jdtls 要导入工程解析 classpath）。慢不等于卡死，用 `lsp status` 看是「启动中」还是「就绪」，启动中时日志路径也会一并打出来。
- **LSP 和 CBM 分工不同**：CBM 是全仓 best-effort 索引，跨语言、不需要项目能构建，适合先划范围；LSP 精确（认得重载、接口实现、泛型），但只覆盖装了服务器的语言且依赖项目能被正确导入。**先用 CBM 找线索，要确定结论时用 LSP 验证。**
- **LSP 查不到不等于不存在**：语言服务器没就绪、项目导入失败、文件不在工作区内，都会返回空结果。拿不准就用 `read`/`grep` 兜底，不要据此断言代码不存在。
- **诊断不能替代构建和测试**。它反映的是语言服务器的视角，最终仍以项目自己的构建、lint 和测试为准。
- 参数里含 `|`、`*`、`?`、`#` 必须用单引号包起来，否则命令会被权限网关拒绝。
- `lsp install` 和 `lsp stop` 在非交互模式（subagent）会被拒绝。`stop` 会踢掉别的会话正在用的热实例，需要时由主 Agent 执行。

## 编辑后会自动诊断

`edit`/`write` 之后，如果该文件所属语言装了服务器，诊断会自动追加到工具结果里，**干净就什么都不加**。所以改完代码通常不必再手动跑一次 `lsp diag`；手动跑主要用于改动前摸底、或确认别的文件有没有被牵连。
