/**
 * 编辑后自动诊断：edit / write 之后把该文件的类型或编译错误追加进工具结果，
 * 让模型改完立刻知道有没有改坏，而不必等到跑完整构建。
 *
 * 纪律：任何失败都静默跳过。诊断是锦上添花，绝不能因为语言服务器没起来就拖慢或打断编辑。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const LSP_CLI = "/home/efren/.pi/agent/bin/lsp";
const GLOBAL_CONFIG = path.join(os.homedir(), ".pi", "agent", "lsp", "servers.json");
/** 语言服务器冷启动时这一次会超时，静默跳过；daemon 在后台继续起，下一次编辑就有诊断了。 */
const DIAGNOSTIC_TIMEOUT_MS = 5000;
const MAX_ITEMS = 20;
const WATCHED_TOOLS = new Set(["edit", "write"]);
/** 只报错误和警告：info/hint 噪音太大，不值得占上下文。 */
const MAX_SEVERITY = 2;
const SEVERITY_LABEL: Record<number, string> = { 1: "error", 2: "warning" };

interface Diagnostic {
	range?: { start?: { line?: number; character?: number } };
	severity?: number;
	message: string;
	code?: string | number;
	source?: string;
}

/** 支持的扩展名从 CLI 问一次就缓存，省得对着 .md、.json 也去 spawn 一个进程。 */
let supportedExtensions: Set<string> | null = null;

function readAutoDiagnostics(file: string): boolean | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { autoDiagnostics?: unknown };
		return typeof parsed.autoDiagnostics === "boolean" ? parsed.autoDiagnostics : undefined;
	} catch {
		return undefined;
	}
}

/** 项目级 .pi/lsp.json 优先于全局 servers.json，两者都没写就默认开启。 */
function autoDiagnosticsEnabled(cwd: string): boolean {
	return readAutoDiagnostics(path.join(cwd, ".pi", "lsp.json")) ?? readAutoDiagnostics(GLOBAL_CONFIG) ?? true;
}

function execJson(args: string[], timeoutMs: number, cwd: string): Promise<unknown | null> {
	return new Promise((resolve) => {
		execFile(LSP_CLI, args, { timeout: timeoutMs, cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error || !stdout) {
				resolve(null);
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve(null);
			}
		});
	});
}

async function loadSupportedExtensions(cwd: string): Promise<Set<string>> {
	if (supportedExtensions) return supportedExtensions;
	const rows = (await execJson(["servers", "--json"], 8000, cwd)) as
		| Array<{ extensions?: string[]; disabled?: boolean; available?: boolean }>
		| null;
	const set = new Set<string>();
	for (const row of rows ?? []) {
		if (row.disabled || !row.available) continue;
		for (const ext of row.extensions ?? []) set.add(ext);
	}
	// 问不到就留空集合，本次会话不再自动诊断——比每次编辑都白 spawn 一个进程强。
	supportedExtensions = set;
	return set;
}

function formatBlock(file: string, diagnostics: Diagnostic[]): string {
	const relative = path.relative(process.cwd(), file) || file;
	const shown = diagnostics.slice(0, MAX_ITEMS);
	const lines = shown.map((item) => {
		const line = (item.range?.start?.line ?? 0) + 1;
		const column = (item.range?.start?.character ?? 0) + 1;
		const severity = SEVERITY_LABEL[item.severity ?? 1] ?? "error";
		const code = item.code !== undefined ? ` [${item.code}]` : "";
		return `  ${relative}:${line}:${column} ${severity}: ${item.message.replace(/\s+/g, " ")}${code}`;
	});
	const omitted = diagnostics.length - shown.length;
	if (omitted > 0) lines.push(`  … 另有 ${omitted} 条未显示`);
	return [`LSP 诊断（本次编辑后，${diagnostics.length} 条）：`, ...lines].join("\n");
}

export default function lspDiagnostics(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		if (!WATCHED_TOOLS.has(event.toolName) || event.isError) return undefined;
		if (!autoDiagnosticsEnabled(ctx.cwd)) return undefined;
		const rawPath = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

		const file = path.resolve(ctx.cwd, rawPath);
		const extensions = await loadSupportedExtensions(ctx.cwd);
		if (!extensions.has(path.extname(file).toLowerCase())) return undefined;

		const results = (await execJson(
			["diag", file, "--json", "--timeout", String(DIAGNOSTIC_TIMEOUT_MS)],
			DIAGNOSTIC_TIMEOUT_MS + 2000,
			ctx.cwd,
		)) as Array<{ diagnostics?: Diagnostic[] }> | null;
		if (!results) return undefined;

		const diagnostics = (results[0]?.diagnostics ?? []).filter((item) => (item.severity ?? 1) <= MAX_SEVERITY);
		// 干净就什么都不加，别制造噪音。
		if (diagnostics.length === 0) return undefined;

		return { content: [...event.content, { type: "text", text: formatBlock(file, diagnostics) }] };
	});
}
