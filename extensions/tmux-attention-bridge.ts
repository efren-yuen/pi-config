/**
 * pi ↔ tmux-attention 桥：把 agent 运行状态同步到当前 tmux pane，
 * 供 tmux 状态栏和 tmux-fzf-jump 弹窗显示（working / done / review）。
 *
 * 状态映射：
 *   agent_start            → turn-start（working，正在跑）
 *   agent_settled 正常结束 → turn-done（done，等用户回来看）
 *   agent_settled 出错     → review --reason error:...（需要人处理）
 *   agent_settled 被中止   → turn-stop（人就在旁边按的 Esc，直接清掉）
 *
 * gate：只在 TUI + tmux 环境生效。subagent 是 json 模式（mode 不是 tui，
 * 不能用 hasUI 判断——RPC 模式下 hasUI 也是 true），tmux 外的 pi 没有-pane 可标。
 * outcome 判定逻辑与 notify.ts 一致（stopReason error/aborted）。
 * 纪律：任何失败都静默跳过，状态标记绝不能拖慢或打断主流程。
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = "/home/efren/.config/tmux/plugins/tmux-attention/scripts/tmux-attention";
const TIMEOUT_MS = 3000;
/** 错误信息塞进 reason 的截断长度，太长了弹窗里也显示不下。 */
const REASON_MAX = 80;

type RunOutcome = { kind: "error"; message: string } | { kind: "aborted" };

function run(args: string[]): Promise<void> {
	return new Promise((resolve) => {
		execFile(CLI, args, { timeout: TIMEOUT_MS }, () => resolve());
	});
}

/**
 * 只有 stopReason === "error" 算出错；"aborted" 是人自己按 Esc 停的。
 * 倒序找最后一条 assistant 消息，和 notify.ts 完全一致。
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

export default function tmuxAttentionBridge(pi: ExtensionAPI): void {
	let lastOutcome: RunOutcome | undefined;

	pi.on("agent_start", async (_event, ctx) => {
		lastOutcome = undefined;
		if (ctx?.mode !== "tui" || !process.env.TMUX) return;
		// 不传 --project，CLI 自动从 git 分支/仓库/cwd 推断
		await run(["turn-start"]);
	});

	// agent_end 每轮底层循环都触发，自动重试还会再来一轮，以最后一次为准。
	pi.on("agent_end", async (event) => {
		lastOutcome = outcomeOf(event.messages);
	});

	// agent_settled 才确定不会再自动重试/压缩/续跑。
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !process.env.TMUX) return;
		if (ctx.hasPendingMessages()) return;
		const outcome = lastOutcome;
		lastOutcome = undefined;
		if (outcome?.kind === "aborted") {
			await run(["turn-stop"]);
			return;
		}
		if (outcome?.kind === "error") {
			await run(["review", "--source", "pi", "--reason", `error: ${outcome.message.slice(0, REASON_MAX)}`]);
			return;
		}
		await run(["turn-done"]);
	});

	// pi 退出时清掉挂着的 working 状态，防止 pane 显示假活跃。
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !process.env.TMUX) return;
		await run(["turn-stop"]);
	});
}
