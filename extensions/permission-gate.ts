/**
 * Pi 权限网关：防止常见误操作，不是操作系统级沙箱。
 * 正则和字符串规则只能覆盖常见形式，不能替代最小权限、备份和人工审查。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ToolCallEventResult,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch", "ls-files", "rev-parse", "describe"]);
const SAFE_VERSION_COMMANDS = new Set(["node", "npm", "pnpm", "yarn", "bun", "python", "python3", "pip", "pip3", "git", "pi", "docker"]);
const SAFE_METADATA_COMMANDS = new Set(["pwd", "whoami", "id", "date", "uname", "df", "free", "which"]);

/**
 * 校验类命令白名单：让非交互模式下的 subagent 能运行测试、构建和静态检查。
 * 这些命令会执行项目自身的脚本，属于有意放宽的边界；破坏性操作仍由 blockedCommand 先行拦截。
 * 只放行校验语义的脚本名和目标，`npm run deploy`、`mvn deploy` 这类有外部副作用的仍会被拒。
 */
const SAFE_CHECK_SCRIPT = /^(?:test|tests|lint|typecheck|type-check|check|build|compile|coverage|e2e|unit|verify|stylelint)(?:[:._-][\w.:-]+)?$/;
const SAFE_MAVEN_GOALS = new Set(["clean", "validate", "compile", "test-compile", "test", "verify", "package"]);
const SAFE_GRADLE_TASKS = new Set(["clean", "test", "check", "build", "assemble", "classes", "compileJava", "compileKotlin"]);
const SAFE_CARGO_SUBCOMMANDS = new Set(["test", "check", "clippy", "build"]);
const SAFE_GO_SUBCOMMANDS = new Set(["test", "build", "vet"]);
const SAFE_CHECK_COMMANDS = new Set(["pytest", "tox", "mypy", "ruff", "flake8", "tsc", "vue-tsc", "eslint", "vitest", "jest"]);

/**
 * 脚本名只能证明意图、不能证明行为，`npm run test:deploy` 这类命名要在匹配前先排除。
 */
const UNSAFE_SCRIPT_HINT = /deploy|publish|release|upload|push|prod|start|serve|migrat|clean/i;

/**
 * 构建工具选项：只放行不会加载外部代码的形式，`-D` 仅限测试相关的键。
 * 这样 `mvn -Dmaven.ext.class.path=/tmp/evil.jar test` 这类扩展加载会被拒。
 */
const SAFE_BUILD_OPTIONS = new Set(["-q", "--quiet", "-B", "--batch-mode", "-o", "--offline", "-ntp", "--no-transfer-progress", "--no-daemon", "--console=plain"]);
const SAFE_BUILD_PROPERTY = /^-D(?:test|it\.test|skipTests|failIfNoTests|maven\.test\.skip|surefire\.[\w.]+)=[\w.,$#-]*$/;

/**
 * 检查工具的选项一律走白名单：黑名单挡不住 `-c/tmp/evil.ini` 连写、`--config-file=`、`--parser=`
 * 这类变体，而 eslint 的配置和 parser 都是可执行 JS、pytest 的 -p 会加载任意插件、
 * go 的 -exec 和 cargo 的 --config 能直接指定要运行的程序，任何一个漏网都等同于任意代码执行。
 * 未列出的选项一律拒绝，需要时按实际用法逐个补。
 */
const SAFE_CHECK_OPTION =
	/^(?:--|-q|--quiet|--silent|-v|--verbose|--version|-h|--help|--color|--color=\w+|--no-color|--noEmit|--no-emit|--strict|--pretty|-x|--exitfirst|--maxfail=\d+|--tb=(?:short|long|line|no|auto|native)|--durations=\d+|--collect-only|--co|--no-header|--no-summary|--strict-markers|--max-warnings=\d+|--coverage|--reporter=\w+|--run|--no-daemon|--offline|--locked|--workspace|--all-features|--no-fail-fast|--release)$/;

function hasOnlySafeCheckOptions(args: string[]): boolean {
	return args.every((arg) => !arg.startsWith("-") || SAFE_CHECK_OPTION.test(arg));
}

function isSensitiveName(name: string): boolean {
	return (
		name === "auth.json" ||
		name === ".ssh" ||
		name === ".aws" ||
		name === ".azure" ||
		name === ".kube" ||
		name === ".env" ||
		name.startsWith(".env.") ||
		/^credentials(?:\.[\w-]+)?$/.test(name) ||
		name === "application_default_credentials.json" ||
		/^service-account(?:\.[\w-]+)?$/.test(name) ||
		/^id_rsa[\w.-]*$/.test(name) ||
		/^id_ed25519[\w.-]*$/.test(name)
	);
}

function normalizeCommand(value: unknown): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

function isProtectedLexicalPath(filePath: string): boolean {
	const segments = filePath.toLowerCase().split(path.sep).filter(Boolean);
	return segments.some((segment, index) => {
		if (isSensitiveName(segment)) return true;
		return segment === ".config" && segments[index + 1] === "gcloud";
	});
}

/**
 * 解析符号链接时不读取文件内容：现有目标优先 realpath；新文件则检查最近存在父目录。
 */
async function isProtectedWritePath(value: unknown, cwd: string): Promise<boolean> {
	if (typeof value !== "string" || !value.trim()) return true;
	const resolved = path.resolve(cwd, value);
	if (isProtectedLexicalPath(resolved)) return true;

	let current = resolved;
	while (true) {
		try {
			const realCurrent = await fs.realpath(current);
			const resolvedTarget = path.join(realCurrent, path.relative(current, resolved));
			return isProtectedLexicalPath(realCurrent) || isProtectedLexicalPath(resolvedTarget);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return false;
			current = parent;
		}
	}
}

/**
 * 只解析 git 的前置全局选项，避免把普通子命令中的字符串误认成 push。
 * 无法识别的复杂形式仍会走后续 fail-closed 确认，不会在非交互模式执行。
 */
function getGitPushIndex(command: string): number {
	const tokens = command.split(" ").filter(Boolean);
	if (tokens[0] !== "git") return -1;

	const optionsWithSeparateValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix", "--list-cmds"]);
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "push") return index;
		if (optionsWithSeparateValue.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) continue;
		if (token.startsWith("--")) continue;
		if (token.startsWith("-")) continue;
		return -1;
	}
	return -1;
}

function isGitForcePush(command: string): boolean {
	const tokens = command.split(" ").filter(Boolean);
	const pushIndex = getGitPushIndex(command);
	if (pushIndex < 0) return false;
	return tokens.slice(pushIndex + 1).some((token) => token === "--force" || token === "--force-with-lease" || /^-f+$/.test(token) || token.startsWith("+"));
}

function blockedCommand(command: string): string | undefined {
	if (/\brm\s+(?:-[^\s]*[rf][^\s]*|--recursive)[^\n]*(?:^|\s)(?:\/|\/etc|\/usr|\/var|\/home)(?:\/|\s|$)/i.test(command)) {
		return "Denied: recursive delete of root or a system directory.";
	}
	if (/\b(?:mkfs(?:\.[\w-]+)?|fdisk|parted)\b|\bdd\b[^\n]*\bof=\/dev\/(?:sd|vd|nvme|mapper\/)|>\s*\/dev\/(?:sd|vd|nvme|mapper\/)/i.test(command)) {
		return "Denied: disk format or raw disk write.";
	}
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/i.test(command)) return "Denied: fork bomb.";
	if (isGitForcePush(command)) {
		return "Denied: git force push.";
	}
	if (/\b(?:chmod|chown)\b[^\n]*\b777\b/i.test(command)) return "Denied: chmod/chown 777.";
	if (/\b(?:curl|wget)\b[^\n]*(?:-d\s+@|--data(?:-binary)?\s+@)[^\n]*(?:\.env|\.ssh|auth\.json|credentials(?:\.[\w-]+)?|application_default_credentials\.json|service-account(?:\.[\w-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*)/i.test(command)) {
		return "Denied: uploading a credential file.";
	}
	if (/\b(?:curl|wget)\b[^\n]*\$\([^\n]*(?:cat|base64)[^\n]*(?:\.env|\.ssh|auth\.json|credentials(?:\.[\w-]+)?|application_default_credentials\.json|service-account(?:\.[\w-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*)/i.test(command)) {
		return "Denied: sending credentials to a network command.";
	}
	if (/\b(?:printenv|env)\b[^\n|]*\|[^\n]*(?:curl|wget)\b/i.test(command)) return "Denied: leaking environment variables over the network.";
	if (/(?:^|[\s/'"=])(?:auth\.json|\.env(?:\.[\w-]+)?|\.ssh|\.aws|\.azure|\.kube|\.config\/gcloud|credentials(?:\.[\w-]+)?|application_default_credentials\.json|service-account(?:\.[\w-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*)(?:[\s/'"=]|$)/i.test(command)) {
		return "Denied: command references a protected path.";
	}
	return undefined;
}

function hasShellSyntax(command: string): boolean {
	return /[|&;<>`$(){}[\]*?!#\\]/.test(command);
}

function hasOnlyAllowedGitOptions(args: string[], allowed: Set<string>): boolean {
	return args.every((arg) => allowed.has(arg));
}

function isExplicitReadOnlyGit(args: string[]): boolean {
	const [subcommand, ...options] = args;
	if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
	if (options.length === 0) return true;

	switch (subcommand) {
		case "status":
			return hasOnlyAllowedGitOptions(options, new Set(["--short", "--porcelain", "--branch", "--show-stash", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all", "-s", "-b", "-uno", "-unormal", "-uall"]));
		case "diff":
			return hasOnlyAllowedGitOptions(options, new Set(["--cached", "--staged", "--stat", "--name-only", "--name-status", "--summary", "--check", "--no-ext-diff"]));
		case "log":
			return hasOnlyAllowedGitOptions(options, new Set(["--oneline", "--decorate", "--all", "--stat", "--name-only", "--name-status", "--no-walk"]));
		case "branch":
			return hasOnlyAllowedGitOptions(options, new Set(["--show-current", "--list", "-l", "--verbose", "-v", "--no-color", "--color=never"]));
		case "ls-files":
			return hasOnlyAllowedGitOptions(options, new Set(["--cached", "--modified", "--deleted", "--others", "--ignored", "--exclude-standard", "--stage", "-s", "-m", "-d", "-o", "-i"]));
		case "rev-parse":
			return hasOnlyAllowedGitOptions(options, new Set(["--is-inside-work-tree", "--is-inside-git-dir", "--show-toplevel", "--git-dir", "--show-prefix", "--show-superproject-working-tree"]));
		default:
			return false;
	}
}

/**
 * Node 包管理器：只放行测试和检查类脚本，`npm run deploy` 这类脚本仍会被拒。
 * pnpm 和 yarn 允许省略 run 直接写脚本名，需要一并识别。
 */
function isReadOnlyNodeScript(program: string, args: string[]): boolean {
	const [first, ...rest] = args;
	if (!first) return false;
	// 透传给脚本的参数同样要过滤：`npm run lint -- --fix` 会写回源码，
	// `npm test --prefix /tmp/evil` 会跑到别的目录去执行脚本。
	if (!hasOnlySafeCheckOptions(args)) return false;
	if (first === "test" || first === "t") return true;
	if (first === "run") {
		const script = rest[0];
		if (typeof script !== "string" || UNSAFE_SCRIPT_HINT.test(script)) return false;
		return SAFE_CHECK_SCRIPT.test(script);
	}
	if (program === "pnpm" || program === "yarn") {
		return !UNSAFE_SCRIPT_HINT.test(first) && SAFE_CHECK_SCRIPT.test(first);
	}
	return false;
}

/**
 * Maven 和 Gradle：过滤掉以 `-` 开头的选项后，要求剩余目标全部在白名单内。
 * 这样 `mvn -q clean test` 通过，而 `mvn deploy`、`gradle publish` 被拒。
 */
function isJvmWrapper(program: string, name: string): boolean {
	return program === name || program === `./${name}`;
}

function isReadOnlyJvmBuild(program: string, args: string[]): boolean {
	// 只认精确的 wrapper 名：后缀匹配会把 `./evilmvnw` 也当成 Maven，等于放行任意二进制。
	const isMaven = program === "mvn" || isJvmWrapper(program, "mvnw");
	const isGradle = program === "gradle" || isJvmWrapper(program, "gradlew");
	if (!isMaven && !isGradle) return false;

	// 选项必须逐个识别；只过滤掉 `-` 开头的参数会放过 `-I evil.gradle` 这类代码加载。
	const isSafeOption = (arg: string) => SAFE_BUILD_OPTIONS.has(arg) || SAFE_BUILD_PROPERTY.test(arg);
	if (args.some((arg) => arg.startsWith("-") && !isSafeOption(arg))) return false;

	const goals = args.filter((arg) => !arg.startsWith("-"));
	if (goals.length === 0) return false;
	const allowed = isMaven ? SAFE_MAVEN_GOALS : SAFE_GRADLE_TASKS;
	return goals.every((goal) => allowed.has(goal));
}

/**
 * 识别测试、构建和静态检查命令，供非交互模式下的 subagent 执行验证。
 */
function isExplicitReadOnlyCheck(program: string, args: string[]): boolean {
	if (["npm", "pnpm", "yarn", "bun"].includes(program)) return isReadOnlyNodeScript(program, args);
	if (isReadOnlyJvmBuild(program, args)) return true;
	// 子命令之后的参数也必须逐个过：go 的 -exec、cargo 的 --config 都能指定要运行的程序。
	if (program === "cargo") return SAFE_CARGO_SUBCOMMANDS.has(args[0] ?? "") && hasOnlySafeCheckOptions(args.slice(1));
	if (program === "go") return SAFE_GO_SUBCOMMANDS.has(args[0] ?? "") && hasOnlySafeCheckOptions(args.slice(1));
	if (program === "python" || program === "python3") {
		return args[0] === "-m" && SAFE_CHECK_COMMANDS.has(args[1] ?? "") && hasOnlySafeCheckOptions(args.slice(2));
	}
	if (SAFE_CHECK_COMMANDS.has(program)) return hasOnlySafeCheckOptions(args);
	return false;
}

/**
 * cbm 与 context7 的只读 CLI：skill 用它们替代原来的 MCP 通道，subagent 也要能直接调用。
 * 程序名精确匹配裸名或绝对路径，不做 basename 归一 —— 否则任意目录下的同名脚本都会被放行。
 */
const SAFE_CBM_PROGRAMS = new Set(["codebase-memory-mcp", "/usr/bin/codebase-memory-mcp"]);
const SAFE_C7_PROGRAMS = new Set(["c7", "/home/efren/.pi/agent/bin/c7"]);
const SAFE_DB_PROGRAMS = new Set(["db", "/home/efren/.pi/agent/bin/db"]);
const SAFE_DB_SUBCOMMANDS = new Set(["tables", "schema", "query", "explain"]);
const SAFE_CBM_TOOLS = new Set([
	"list_projects",
	"index_status",
	"get_architecture",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
	"query_graph",
	"check_index_coverage",
	"detect_changes",
	"get_graph_schema",
]);
const SAFE_CBM_DAEMON = new Set(["start", "status"]);
const SAFE_C7_SUBCOMMANDS = new Set(["search", "docs"]);

/**
 * lsp 的只读查询与 cbm/c7 同档：subagent 也要能用。
 * 常驻 daemon 是跨进程共享的，reviewer 拿到的诊断和主 Agent 是同一个热实例算出来的。
 * install 会下载并写盘、stop 会踢掉别的会话正在用的实例、__daemon 是内部入口，三者都不放行。
 */
const SAFE_LSP_PROGRAMS = new Set(["lsp", "/home/efren/.pi/agent/bin/lsp"]);
const SAFE_LSP_SUBCOMMANDS = new Set([
	"diag", "def", "refs", "impl", "hover", "callers", "callees", "symbols", "search", "status", "servers",
]);
const SAFE_LSP_OPTIONS = new Set([
	"--line", "--col", "--symbol", "--server", "--file", "--min-severity", "--max", "--timeout", "--json",
]);

/**
 * 上网 CLI 单独一档：它不进只读白名单，而是在 assessCommand 里按 hasUI 分流 ——
 * 交互会话（主 Agent）免确认放行，非交互（subagent）一律拒。
 */
const SAFE_WEB_PROGRAMS = new Set(["web", "/home/efren/.pi/agent/bin/web"]);
const SAFE_WEB_SUBCOMMANDS = new Set(["search", "fetch", "usage"]);
const SAFE_WEB_OPTIONS = new Set([
	"--provider", "--num", "--type", "--livecrawl", "--max-chars",
	"--format", "--timeout", "--jina", "--tavily", "--json",
]);

/**
 * cbm 的选项同样走白名单：`--ui=true`、`--port=`、`--tool-profile=` 会持久化改配置或起服务，
 * 不能因为它们长得像查询参数就放过。下表是上面各只读工具 `--help` 输出的并集，加两个无副作用的全局开关；
 * `--args-file` 能读任意路径的文件、出错时还可能回显内容，不放行。
 */
const SAFE_CBM_CLI_OPTIONS = new Set([
	"--progress", "--json",
	"--aspects", "--base-branch", "--context", "--cursor", "--debug", "--depth", "--detail",
	"--direction", "--edge-types", "--exclude-entry-points", "--fields", "--file-pattern",
	"--format", "--function-name", "--graph", "--include-connected", "--include-details",
	"--include-evidence", "--include-neighbors", "--include-tests", "--label", "--limit",
	"--max-degree", "--max-rows", "--metadata-only", "--min-degree", "--mode", "--name-pattern",
	"--offset", "--parameter-name", "--path", "--path-filter", "--paths", "--pattern", "--project",
	"--qn-pattern", "--qualified-name", "--query", "--regex", "--relationship", "--risk-labels",
	"--scope", "--scope-limit", "--scope-offset", "--scopes", "--semantic-query", "--since", "--verbose",
]);
const SAFE_C7_OPTIONS = new Set(["--tokens", "--json"]);

/**
 * 引号感知扫描：`--file-pattern '*.java'`、`--pattern 'a|b'` 这类参数在 hasShellSyntax 下会被
 * 整条拒掉，但引号内的字符根本不会被 shell 解释，逐字符判断才放得准。
 * 引号外维持 hasShellSyntax 的严格集合；双引号内仍禁 `$`、反引号和反斜杠 —— 它们照样会被展开。
 * 返回 null 表示命令不安全或引号未闭合，返回的 token 列表供白名单校验使用。
 */
function tokenizeQuotedCommand(command: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: "'" | '"' | null = null;

	for (const char of command) {
		if (quote === null) {
			if (char === " ") {
				if (started) {
					tokens.push(current);
					current = "";
					started = false;
				}
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				started = true;
				continue;
			}
			if (/[|&;<>`$(){}[\]*?!#\\]/.test(char)) return null;
			current += char;
			started = true;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (quote === '"' && (char === "$" || char === "`" || char === "\\")) return null;
		current += char;
	}

	if (quote !== null) return null;
	if (started) tokens.push(current);
	return tokens;
}

/**
 * 选项名允许 `--flag value` 和 `--flag=value` 两种写法，值本身不校验：
 * 它已经过引号扫描，不会被 shell 解释。
 */
function hasOnlyAllowedCliOptions(args: string[], allowed: Set<string>): boolean {
	return args.every((arg) => {
		if (!arg.startsWith("-")) return true;
		const name = arg.split("=", 1)[0];
		return allowed.has(name);
	});
}

/**
 * cbm / c7 只放行查询语义的子命令：cbm 的 index_repository、delete_project、manage_adr、
 * ingest_traces 会改索引，install/uninstall/update/config 会改本机配置，一律留给交互模式确认。
 */
function isReadOnlyDbCli(command: string): boolean {
	const tokens = tokenizeQuotedCommand(command);
	if (!tokens) return false;
	const [program, ...args] = tokens;
	if (!program || !SAFE_DB_PROGRAMS.has(program)) return false;
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return true;
	if (args[0] !== "mysql" || !SAFE_DB_SUBCOMMANDS.has(args[1] ?? "")) return false;
	const subcommand = args[1];
	if (subcommand === "tables") return args.length === 2;
	return args.length === 3 && !args[2].startsWith("-");
}

function isReadOnlySkillCli(command: string): boolean {
	if (isReadOnlyDbCli(command)) return true;
	const tokens = tokenizeQuotedCommand(command);
	if (!tokens) return false;
	const [program, ...args] = tokens;
	if (!program) return false;

	if (SAFE_CBM_PROGRAMS.has(program)) {
		const [subcommand, ...rest] = args;
		if (subcommand === "cli") {
			const tool = rest.find((arg) => !arg.startsWith("-"));
			if (!tool || !SAFE_CBM_TOOLS.has(tool)) return false;
			// 工具名之后可以带 --help 自查参数，但选项仍要逐个过白名单。
			const options = rest.filter((arg) => arg !== tool);
			if (options.length === 1 && (options[0] === "--help" || options[0] === "-h")) return true;
			return hasOnlyAllowedCliOptions(options, SAFE_CBM_CLI_OPTIONS);
		}
		if (subcommand === "daemon") return rest.length === 1 && SAFE_CBM_DAEMON.has(rest[0] ?? "");
		return args.length === 1 && ["--version", "--help", "-h"].includes(args[0] ?? "");
	}

	if (SAFE_C7_PROGRAMS.has(program)) {
		const [subcommand, ...rest] = args;
		if (subcommand === "--help" || subcommand === "-h") return args.length === 1;
		if (!subcommand || !SAFE_C7_SUBCOMMANDS.has(subcommand)) return false;
		return hasOnlyAllowedCliOptions(rest, SAFE_C7_OPTIONS);
	}

	if (SAFE_LSP_PROGRAMS.has(program)) {
		const [subcommand, ...rest] = args;
		if (subcommand === "--help" || subcommand === "-h") return args.length === 1;
		if (!subcommand || !SAFE_LSP_SUBCOMMANDS.has(subcommand)) return false;
		return hasOnlyAllowedCliOptions(rest, SAFE_LSP_OPTIONS);
	}

	return false;
}

/**
 * 上网命令的形状校验。放行与否由调用方按 hasUI 决定，这里只保证命令本身干净：
 * 子命令在白名单内、选项在白名单内、没有引号外的 shell 语法。
 */
function isWebCli(command: string): boolean {
	const tokens = tokenizeQuotedCommand(command);
	if (!tokens) return false;
	const [program, ...args] = tokens;
	if (!program || !SAFE_WEB_PROGRAMS.has(program)) return false;

	const [subcommand, ...rest] = args;
	if (subcommand === "--help" || subcommand === "-h") return args.length === 1;
	if (!subcommand || !SAFE_WEB_SUBCOMMANDS.has(subcommand)) return false;
	return hasOnlyAllowedCliOptions(rest, SAFE_WEB_OPTIONS);
}

function isExplicitReadOnlyCommand(command: string): boolean {
	// 引号感知的分支要排在 hasShellSyntax 之前：cbm 的 glob 和正则参数在那一关会被整条拒掉。
	if (isReadOnlySkillCli(command)) return true;
	if (hasShellSyntax(command)) return false;
	const tokens = command.split(" ").filter(Boolean);
	const [program, ...args] = tokens;
	if (!program) return false;

	if (["ls", "grep"].includes(program)) return true;
	if (program === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	if (program === "find") {
		return !args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg) || /^-f(?:print|printf|ls)/.test(arg));
	}
	if (program === "git") return isExplicitReadOnlyGit(args);
	if (program === "pi" && args.length === 1 && args[0] === "list") return true;
	if (isExplicitReadOnlyCheck(program, args)) return true;
	if (SAFE_VERSION_COMMANDS.has(program)) return args.length === 1 && ["--version", "-v", "-V"].includes(args[0]);
	if (SAFE_METADATA_COMMANDS.has(program)) return true;
	return false;
}

async function assessCommand(command: string, hasUI: boolean, select: (title: string, options: string[]) => Promise<string | undefined>): Promise<string | undefined> {
	const blocked = blockedCommand(command);
	if (blocked) return blocked;
	if (isExplicitReadOnlyCommand(command)) return undefined;
	// 上网只给交互会话：主 Agent 免确认，subagent 一律拒——额度和外部内容都该由人盯着。
	if (isWebCli(command)) {
		return hasUI ? undefined : "Denied: web access is only available in interactive sessions.";
	}
	if (!hasUI) return "Denied: non-interactive mode only allows known read-only commands.";
	const choice = await select(`⚠️ Unrecognized command, may change your system\n\n${command}\n\nRun it once?`, ["Allow once", "Deny"]);
	return choice === "Allow once" ? undefined : "Denied by user.";
}

function deniedBashResult(reason: string): UserBashEventResult {
	return { result: { output: `Permission gate: ${reason}`, exitCode: 1, cancelled: false, truncated: false } };
}

export default function permissionGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			if (await isProtectedWritePath(event.input.path, ctx.cwd)) {
				return { block: true, reason: "Denied: cannot write or edit a protected path.", terminate: true };
			}
			return undefined;
		}

		if (!isToolCallEventType("bash", event) && !isToolCallEventType("powershell", event)) return undefined;
		const command = normalizeCommand(event.input.command);
		if (!command) return { block: true, reason: "Denied: empty or invalid bash command." };
		event.input.command = command;
		const reason = await assessCommand(command, ctx.hasUI, (title, options) => ctx.ui.select(title, options));
		return reason ? { block: true, reason, terminate: Boolean(blockedCommand(command)) } : undefined;
	});

	pi.on("user_bash", async (event, ctx): Promise<UserBashEventResult | undefined> => {
		const command = normalizeCommand(event.command);
		if (!command) return deniedBashResult("Empty or invalid bash command.");
		event.command = command;
		const reason = await assessCommand(command, ctx.hasUI, (title, options) => ctx.ui.select(title, options));
		return reason ? deniedBashResult(reason) : undefined;
	});
}
