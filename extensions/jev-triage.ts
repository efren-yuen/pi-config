/**
 * Jev 需求分流：每次用户提交 prompt 后、agent 开跑前，自动跑一次 `jev triage`，
 * 把分类/影响面/风险结果作为消息注入本轮上下文。模型不用（也不能）选择跳过——
 * 这是上一次「靠模型自觉调 skill」失败后的修正：触发点放在事件层，不依赖自觉。
 *
 * 边界（老实说清楚）：
 * - 这是决策支持，不是安全边界。真正拦操作的是 permission-gate 和人工确认。
 * - triage 只看任务描述文本；Jev 不可达/超时/没配 key 时静默跳过，绝不阻塞会话。
 * - 只在交互会话跑（ctx.hasUI），subagent 的非交互模式一律不跑，避免嵌套调用。
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const JEV_BIN = "/home/efren/.pi/agent/bin/jev";
const TIMEOUT_MS = 12_000;
/** prompt 短于这个值直接跳过——「继续」「好的」这类没分流价值。 */
const MIN_PROMPT_CHARS = 12;

function runTriage(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		// execFile 不经 shell，参数里带引号/分号都安全；结果只作为上下文，不再被执行。
		execFile(
			JEV_BIN,
			["triage", prompt],
			{ timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 },
			(err, stdout) => {
				if (err || !stdout.trim()) resolve("");
				else resolve(stdout.trim());
			},
		);
	});
}

export default function jevTriage(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return undefined;
		const prompt = event.prompt?.trim() ?? "";
		if (prompt.length < MIN_PROMPT_CHARS) return undefined;
		// 用户显式在跑 slash 命令或继续上轮的短指令，不分流
		if (prompt.startsWith("/")) return undefined;

		const triage = await runTriage(prompt);
		if (!triage) return undefined;

		return {
			message: {
				customType: "jev_triage",
				content: `【Jev 需求分流（自动，决策支持非安全边界）】\n${triage}\n\n按路由建议行动；建议与实际代码事实冲突时，以代码为准并向用户说明。`,
				display: true,
			},
		};
	});
}
