/**
 * 极简 todo：模型每次提交整张任务表，状态存在 tool result details 里。
 *
 * 为什么不用现成的 todo 包：rpiv-todo 的工具定义 4463 字节（约 1275 token），
 * 相当于每次请求都在为「六种 action + 依赖图 + 墓碑态」付费。实际用法只有
 * 「建表 / 改状态 / 清空」，整表提交一次调用就够。
 *
 * 状态放在 details 而不是外部文件：切分支、重载、--continue 之后按 branch 重建，
 * 天然和会话历史一致。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "completed";

interface Task {
	content: string;
	status: Status;
}

interface TodoDetails {
	tasks: Task[];
}

const MAX_TASKS = 20;

const TodoParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			content: Type.String(),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
		}),
	),
});

const GLYPH: Record<Status, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
};

/** 输入框上方最多 5 行，超出收成一句，不挤占编辑区。 */
const MAX_WIDGET_ROWS = 5;

const WIDGET_KEY = "todo";

/** 校验失败直接把原因抛回去，不改状态。 */
function validate(tasks: Task[]): string | undefined {
	if (tasks.length > MAX_TASKS) return `最多 ${MAX_TASKS} 条，当前 ${tasks.length} 条`;
	for (const [i, t] of tasks.entries()) {
		if (!t.content.trim()) return `第 ${i + 1} 条 content 为空`;
	}
	const doing = tasks.filter((t) => t.status === "in_progress").length;
	if (doing > 1) return `同时只能有 1 条 in_progress，当前 ${doing} 条`;
	return undefined;
}

function formatTasks(tasks: Task[]): string {
	if (tasks.length === 0) return "任务表为空";
	const lines = tasks.map((t, i) => `${GLYPH[t.status]} ${i + 1}. ${t.content}`);
	const done = tasks.filter((t) => t.status === "completed").length;
	lines.push(`— ${done}/${tasks.length} 完成`);
	return lines.join("\n");
}

/** 输入框上方那张表的行。纯 UI 渲染，不进上下文。 */
function widgetLines(list: Task[], theme: Theme): string[] {
	if (list.length === 0) return [];
	const done = list.filter((t) => t.status === "completed").length;
	const shown = list.slice(0, MAX_WIDGET_ROWS);
	const lines = shown.map((t, i) => {
		const mark =
			t.status === "completed"
				? theme.fg("success", GLYPH[t.status])
				: t.status === "in_progress"
					? theme.fg("accent", GLYPH[t.status])
					: theme.fg("dim", GLYPH[t.status]);
		const body = t.status === "completed" ? theme.fg("dim", t.content) : theme.fg("muted", t.content);
		return `${mark} ${i + 1}. ${body}`;
	});
	if (list.length > shown.length) lines.push(theme.fg("dim", `… 还有 ${list.length - shown.length} 条`));
	lines.push(theme.fg("dim", `${done}/${list.length} 完成`));
	return lines;
}

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];

	/** 从当前 branch 的 toolResult 里重放状态。 */
	const reconstruct = (ctx: ExtensionContext) => {
		tasks = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.tasks) tasks = details.tasks;
		}
	};

	/** 把当前表同步到输入框上方；空表就清掉 widget。 */
	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (tasks.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = tasks.map((t) => ({ ...t }));
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) =>
			new Text(widgetLines(snapshot, theme).join("\n"), 0, 0),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		refreshWidget(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Keep a todo list for multi-step work. Submit the whole table each time; tasks: [] clears it. At most one task may be in_progress.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const next = params.tasks as Task[];
			const error = validate(next);
			if (error) {
				return {
					content: [{ type: "text", text: `Error: ${error}` }],
					details: { tasks: [...tasks] } as TodoDetails,
				};
			}
			tasks = next.map((t) => ({ content: t.content.trim(), status: t.status }));
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatTasks(tasks) }],
				details: { tasks: [...tasks] } as TodoDetails,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${count} 条`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			const list = details?.tasks ?? [];
			if (list.length === 0) return new Text(theme.fg("dim", "任务表为空"), 0, 0);
			const done = list.filter((t) => t.status === "completed").length;
			const shown = expanded ? list : list.slice(0, 6);
			const lines = shown.map((t, i) => {
				const mark =
					t.status === "completed"
						? theme.fg("success", GLYPH[t.status])
						: t.status === "in_progress"
							? theme.fg("accent", GLYPH[t.status])
							: theme.fg("dim", GLYPH[t.status]);
				const body = t.status === "completed" ? theme.fg("dim", t.content) : theme.fg("muted", t.content);
				return truncateToWidth(`${mark} ${i + 1}. ${body}`, 120);
			});
			if (!expanded && list.length > shown.length) {
				lines.push(theme.fg("dim", `… 还有 ${list.length - shown.length} 条`));
			}
			lines.push(theme.fg("dim", `${done}/${list.length} 完成`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "显示当前任务表",
		handler: async (_args: string, ctx) => {
			ctx.ui.notify(formatTasks(tasks), "info");
		},
	});
}
