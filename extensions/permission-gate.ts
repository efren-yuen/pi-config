/**
 * Pi 权限网关：只拦真正会造成不可逆损失的事，其余一律放行。
 *
 * 这里**不是**沙箱，也不做「只读命令白名单」——那条路要求列举一切允许的命令，
 * 每接一个新 CLI 就得改一遍，漏一条就是莫名其妙的 Denied，得不偿失。
 * 真正的边界是最小权限账号、备份和人工审查；这个文件只负责挡住手滑和明显的外泄。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ToolCallEventResult,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * 受保护路径只在这里定义一次，命令文本和工具参数两条检查路径共用。
 * 加一种新凭据形态只改这一行。
 */
const SENSITIVE = String.raw`auth\.json|\.env(?:\.[\w-]+)?|\.ssh|\.aws|\.azure|\.kube|credentials(?:\.[\w-]+)?|application_default_credentials\.json|service-account(?:\.[\w-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*`;
/** 命令行里以空白、斜杠或引号为边界出现，才算引用了受保护路径。 */
const SENSITIVE_IN_COMMAND = new RegExp(String.raw`(?:^|[\s/'"=])(?:${SENSITIVE}|\.config\/gcloud)(?:[\s/'"=]|$)`, "i");
/** 单个路径段的完整匹配，用于逐段检查一个已解析的路径。 */
const SENSITIVE_SEGMENT = new RegExp(String.raw`^(?:${SENSITIVE})$`, "i");

/** subagent 联网不好控额度，这一条单独留着；主 Agent 不受限。 */
const WEB_CLI = /(?:^|\/)web\s+(?:search|fetch)\b/;

function normalizeCommand(value: unknown): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

function isProtectedLexicalPath(filePath: string): boolean {
	const segments = filePath.toLowerCase().split(path.sep).filter(Boolean);
	return segments.some((segment, index) => {
		if (SENSITIVE_SEGMENT.test(segment)) return true;
		return segment === ".config" && segments[index + 1] === "gcloud";
	});
}

/**
 * 解析符号链接后再判断，否则 `ln -s ~/.ssh here` 就绕过去了。
 * 不读文件内容：已存在的目标走 realpath，新路径回溯到最近存在的父目录。
 */
async function isProtectedPath(value: unknown, cwd: string): Promise<boolean> {
	if (typeof value !== "string" || !value.trim()) return true;
	const resolved = path.resolve(cwd, value);
	if (isProtectedLexicalPath(resolved)) return true;

	let current = resolved;
	for (;;) {
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

/** 会造成不可逆损失或凭据外泄的命令。命中即拒，不给确认机会。 */
function blockedCommand(command: string): string | undefined {
	if (/\brm\s+(?:-[^\s]*[rf][^\s]*|--recursive)[^\n]*(?:^|\s)(?:\/|\/etc|\/usr|\/var|\/home)(?:\/|\s|$)/i.test(command)) {
		return "Denied: recursive delete of root or a system directory.";
	}
	if (/\b(?:mkfs(?:\.[\w-]+)?|fdisk|parted)\b|\bdd\b[^\n]*\bof=\/dev\/(?:sd|vd|nvme|mapper\/)|>\s*\/dev\/(?:sd|vd|nvme|mapper\/)/i.test(command)) {
		return "Denied: disk format or raw disk write.";
	}
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/i.test(command)) return "Denied: fork bomb.";
	if (/\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f+\b|\s\+\S)/i.test(command)) {
		return "Denied: git force push.";
	}
	if (/\b(?:printenv|env)\b[^\n|]*\|[^\n]*(?:curl|wget)\b/i.test(command)) {
		return "Denied: leaking environment variables over the network.";
	}
	if (SENSITIVE_IN_COMMAND.test(command)) return "Denied: command references a protected path.";
	return undefined;
}

/** fatal 的才终止整轮；普通拒绝只挡这一条命令，让模型拿到理由自己往下说。 */
function assess(command: string, hasUI: boolean): { reason: string; fatal: boolean } | undefined {
	const blocked = blockedCommand(command);
	if (blocked) return { reason: blocked, fatal: true };
	if (!hasUI && WEB_CLI.test(command)) {
		return { reason: "Denied: web access is only available in interactive sessions.", fatal: false };
	}
	return undefined;
}

function deniedBash(reason: string): UserBashEventResult {
	return { result: { output: `Permission gate: ${reason}`, exitCode: 1, cancelled: false, truncated: false } };
}

/** 带路径参数的内置工具：读写都要过受保护路径检查。 */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
/** 这几个的 path 可以省略，省略就是当前目录，不该因此被拦。 */
const OPTIONAL_PATH_TOOLS = new Set(["grep", "find", "ls"]);

export default function permissionGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (PATH_TOOLS.has(event.toolName)) {
			const requested = (event.input as { path?: unknown }).path;
			const hasPath = typeof requested === "string" && requested.trim().length > 0;
			// read/write/edit 的 path 必填，缺失时交给 isProtectedPath fail-closed。
			const target = hasPath ? requested : OPTIONAL_PATH_TOOLS.has(event.toolName) ? "." : requested;
			if (await isProtectedPath(target, ctx.cwd)) {
				return { block: true, reason: "Denied: protected path." };
			}
			return undefined;
		}

		if (!isToolCallEventType("bash", event) && !isToolCallEventType("powershell", event)) return undefined;
		const command = normalizeCommand(event.input.command);
		if (!command) return { block: true, reason: "Denied: empty or invalid bash command." };
		event.input.command = command;
		const verdict = assess(command, ctx.hasUI);
		return verdict ? { block: true, reason: verdict.reason, terminate: verdict.fatal } : undefined;
	});

	pi.on("user_bash", async (event, ctx): Promise<UserBashEventResult | undefined> => {
		const command = normalizeCommand(event.command);
		if (!command) return deniedBash("Empty or invalid bash command.");
		event.command = command;
		const verdict = assess(command, ctx.hasUI);
		return verdict ? deniedBash(verdict.reason) : undefined;
	});
}
