/**
 * 桌面消息通知：任务完成 / 需要授权 / 出错时发一条系统通知，提醒人回到终端。
 *
 * 为什么不用官方示例：examples/extensions/notify.ts 只走 OSC 777、OSC 99(Kitty)
 * 和 Windows Toast，alacritty 这类终端三条都不认，等于没通知。这里直接走
 * notify-send，形式照抄 opencode 的 notifier 插件（`--` 分隔符、--print-id/
 * --replace-id 合并、DBus 守卫这三点是它踩出来的）。
 *
 * 纪律：任何失败都静默跳过。通知是锦上添花，绝不能拖慢或打断主流程。
 *
 * 注意：pi 给每个扩展建独立 jiti 实例且 moduleCache: false，permission-gate.ts
 * 那句 `import "./notify.ts"` 拿到的是本模块的第二份实例，模块级状态不共享。
 * 所以授权通知的标题只会是目录名（取不到 sessionName），也不与完成通知共享
 * --replace-id。两者都无害，别当 bug 查。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** gruvbox 配色的变体；官方原图 pi.png 保留在 assets/ 里没动。 */
const ICON = "/home/efren/.pi/agent/assets/pi-gruvbox.png";
const APP_NAME = "pi";
/** 完成和出错看一眼就够；授权是在等人操作，留久一点。 */
const EXPIRE_DONE_MS = 5000;
const EXPIRE_PERMISSION_MS = 8000;
/** 秒回的问题不值得弹窗——人还没来得及走神。 */
const MIN_DURATION_MS = 3000;
/** 确认框弹出后等这么久还没人作答，就认定人走开了。人没走开的情况由作答时的自动撤销兜住。 */
const PERMISSION_DELAY_MS = 3_000;
/** 正文相同且间隔小于这个值就丢弃，防同一件事连响两次。 */
const DEBOUNCE_MS = 1000;
/** 聚焦探测卡住就当"没聚焦"照常通知——宁可多响，不可漏。 */
const FOCUS_PROBE_TIMEOUT_MS = 500;
const NOTIFY_TIMEOUT_MS = 3000;
/** 通知正文里任务描述的截断长度，再长一行也放不下。 */
const SUMMARY_MAX = 60;
/**
 * 通知类型，走 notify-send 的 --category 传给 mako。
 * mako 的 summary/body criteria 是精确匹配，认不出正文里的 emoji，
 * 只能靠 category 让 ~/.config/mako/config 里的 [category=...] 换边框色。
 */
const CATEGORY = {
	done: "pi.done",
	error: "pi.error",
	permission: "pi.permission",
	selftest: "pi.selftest",
} as const;

type Category = (typeof CATEGORY)[keyof typeof CATEGORY];

type RunOutcome = { kind: "error"; message: string } | { kind: "aborted" };

/** 上一条通知的 id，用 --replace-id 覆盖它，避免一屏堆满 pi 的通知。 */
let lastNotificationId: number | null = null;
let lastBody = "";
let lastSentAt = 0;
/** 会话名（/name 设过才有），没有就退回目录名。 */
let sessionName: string | undefined;
let runStartedAt: number | undefined;
let lastOutcome: RunOutcome | undefined;
let lastPrompt: string | undefined;

function exec(file: string, args: string[], timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			resolve(error ? null : stdout);
		});
	});
}

/** mako 默认开 Pango markup，正文里一个孤立的 `<` 就能让整条通知解析失败。 */
function escapeMarkup(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summarize(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return escapeMarkup(line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function titleFor(ctx: ExtensionContext): string {
	return `pi (${sessionName || path.basename(ctx.cwd) || "pi"})`;
}

async function send(title: string, body: string, expireMs: number, category: Category): Promise<number | null> {
	// 没有 DBus（tty、ssh、容器）就没有通知总线，直接放弃，别留一堆报错。
	if (!process.env.DBUS_SESSION_BUS_ADDRESS) return null;
	const now = Date.now();
	if (body === lastBody && now - lastSentAt < DEBOUNCE_MS) return null;
	lastBody = body;
	lastSentAt = now;

	const args = ["--app-name", APP_NAME, "--category", category];
	if (fs.existsSync(ICON)) args.push("--icon", ICON);
	args.push("--expire-time", String(expireMs));
	if (lastNotificationId !== null) args.push("--replace-id", String(lastNotificationId));
	// `--` 不能省：正文以 `-` 开头时会被当成 flag。
	args.push("--print-id", "--", title, body);

	const stdout = await exec("notify-send", args, NOTIFY_TIMEOUT_MS);
	const id = Number.parseInt((stdout ?? "").trim(), 10);
	lastNotificationId = Number.isFinite(id) ? id : null;
	return lastNotificationId;
}

/**
 * 撤掉一条已经弹出的通知。走标准 D-Bus 方法而不是 makoctl：
 * 本文件对通知守护是无关的，换掉 mako 也照样能用。
 */
function closeNotification(id: number): void {
	void exec(
		"gdbus",
		[
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.CloseNotification",
			String(id),
		],
		NOTIFY_TIMEOUT_MS,
	);
}

function findFocusedPid(node: unknown): number | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const record = node as { focused?: boolean; pid?: number; nodes?: unknown[]; floating_nodes?: unknown[] };
	if (record.focused && typeof record.pid === "number") return record.pid;
	for (const child of [...(record.nodes ?? []), ...(record.floating_nodes ?? [])]) {
		const found = findFocusedPid(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

function parentPid(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm 字段自带括号且可能含空格，从最后一个 ')' 之后再按空格切才安全。
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ppid = Number.parseInt(fields[1], 10);
		return Number.isFinite(ppid) ? ppid : undefined;
	} catch {
		return undefined;
	}
}

/** 聚焦窗口的进程是不是 pi 的祖先——是的话说明人正盯着这个终端。 */
function isAncestor(ancestor: number, pid: number): boolean {
	let current = pid;
	for (let hops = 0; current > 1 && hops < 32; hops++) {
		if (current === ancestor) return true;
		const parent = parentPid(current);
		if (parent === undefined) return false;
		current = parent;
	}
	return false;
}

async function terminalFocused(): Promise<boolean> {
	const stdout = await exec("swaymsg", ["-t", "get_tree"], FOCUS_PROBE_TIMEOUT_MS);
	if (!stdout) return false;
	let focusedPid: number | undefined;
	try {
		focusedPid = findFocusedPid(JSON.parse(stdout));
	} catch {
		return false;
	}
	return focusedPid === undefined ? false : isAncestor(focusedPid, process.pid);
}

/**
 * 只有 stopReason === "error" 才值得响；"aborted" 是人自己按 Esc 停的，
 * 整轮都不该通知——否则一次中止会被当成"任务完成"报出去。
 */
function outcomeOf(messages: readonly unknown[]): RunOutcome | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return { kind: "error", message: message.errorMessage ?? "provider error" };
		if (message.stopReason === "aborted") return { kind: "aborted" };
		return undefined;
	}
	return undefined;
}

/**
 * permission-gate 弹确认框时调这个，拿到的 cancel 必须在框返回后调用。
 *
 * 为什么是延迟而不是立刻、也不看窗口焦点：框弹出那一刻人一定在（是他触发的），
 * 但这不代表十几秒后人还在。"等了 15 秒没人作答"本身就是"人走开了"的可靠信号，
 * 比探测窗口焦点准，也不依赖 sway。
 */
export function watchPendingPermission(command: string, ctx: ExtensionContext): () => void {
	if (!ctx.hasUI) return () => {};
	let notificationId: number | null = null;
	let answered = false;
	const timer = setTimeout(() => {
		void send(titleFor(ctx), `🔐 需要授权: ${summarize(command)}`, EXPIRE_PERMISSION_MS, CATEGORY.permission).then(
			(id) => {
				// 竞态：定时器已触发、notify-send 还在 spawn 的那几十毫秒里人作答了，
				// 此时 cancel() 拿到的 id 还是 null，得在这里补一次关闭。
				if (answered) {
					if (id !== null) closeNotification(id);
				} else {
					notificationId = id;
				}
			},
		);
	}, PERMISSION_DELAY_MS);
	// 别让这个定时器把 pi 的退出拖住。
	timer.unref?.();
	return () => {
		answered = true;
		clearTimeout(timer);
		if (notificationId !== null) closeNotification(notificationId);
	};
}

export default function notify(pi: ExtensionAPI): void {
	// 自检入口：TUI 里敲 /notify-selftest。提示"未知命令"就说明扩展压根没加载
	// ——pi 只在启动时扫一次 extensions，改完必须 /reload 或重启。
	pi.registerCommand("notify-selftest", {
		description: "自检桌面通知：打印判定链并绕过抑制发一条测试通知",
		handler: async (_args, ctx) => {
			const checks = [
				`hasUI=${ctx.hasUI}`,
				`mode=${ctx.mode}`,
				`dbus=${Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)}`,
				`icon=${fs.existsSync(ICON)}`,
				`terminalFocused=${await terminalFocused()}`,
			].join("  ");
			ctx.ui.notify(`notify 自检 · ${checks}`, "info");
			await send(titleFor(ctx), "🔔 通知自检：看到这条就说明链路是通的", EXPIRE_DONE_MS, CATEGORY.selftest);
		},
	});

	pi.on("session_start", async () => {
		sessionName = undefined;
		runStartedAt = undefined;
		lastOutcome = undefined;
		lastPrompt = undefined;
		lastNotificationId = null;
	});

	pi.on("session_info_changed", async (event) => {
		sessionName = event.name;
	});

	pi.on("before_agent_start", async (event) => {
		lastPrompt = summarize(event.prompt);
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
		lastOutcome = undefined;
	});

	// agent_end 每跑完一轮底层循环就触发，自动重试还会再来一轮，以最后一次为准。
	pi.on("agent_end", async (event) => {
		lastOutcome = outcomeOf(event.messages);
	});

	// agent_settled 才是"确定不会再自动重试/压缩/续跑"，在这里提醒才不会打断。
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages()) return;
		const elapsed = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
		const outcome = lastOutcome;
		runStartedAt = undefined;
		lastOutcome = undefined;
		// 人自己按 Esc 停的，人就在终端前，不用再响一声。
		if (outcome?.kind === "aborted") return;
		// 出错要立刻知道，不受耗时门槛限制。
		if (outcome === undefined && elapsed < MIN_DURATION_MS) return;
		if (await terminalFocused()) return;
		const body =
			outcome !== undefined
				? `❌ 出错: ${summarize(outcome.message)}`
				: `✅ 任务完成 · ${formatDuration(elapsed)}${lastPrompt ? `\n${lastPrompt}` : ""}`;
		await send(titleFor(ctx), body, EXPIRE_DONE_MS, outcome !== undefined ? CATEGORY.error : CATEGORY.done);
	});
}
