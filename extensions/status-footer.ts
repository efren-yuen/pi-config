import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(resolve(home), resolvedCwd);
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	return insideHome ? (relativeToHome ? `~${sep}${relativeToHome}` : "~") : cwd;
}

function addUsage(totals: UsageTotals, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const value = usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const amount = value[key];
		if (typeof amount === "number" && Number.isFinite(amount)) totals[key] += amount;
	}
	if (typeof value.cost?.total === "number" && Number.isFinite(value.cost.total)) {
		totals.cost += value.cost.total;
	}
}

/** 用主题语义色映射 Gruvbox 的 provider、模型和思考等级。 */
function modelLabel(
	provider: string,
	modelName: string,
	thinkingLevel: string | undefined,
	reasoning: boolean | undefined,
	theme: Theme,
): string {
	let label = `${provider ? theme.fg("muted", provider) : ""}${theme.fg("accent", modelName)}`;
	if (!reasoning) return label;

	const level = thinkingLevel || "off";
	const color =
		level === "minimal"
			? "thinkingMinimal"
			: level === "low"
				? "thinkingLow"
				: level === "medium"
					? "thinkingMedium"
					: level === "high"
						? "thinkingHigh"
						: level === "xhigh"
							? "thinkingXhigh"
							: level === "max"
								? "thinkingMax"
								: "thinkingOff";
	label += ` ${theme.fg(color, `• ${level}`)}`;
	return label;
}

export default function statusFooter(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => unsubscribe(),
				invalidate() {},
				render(width: number): string[] {
					const totals: UsageTotals = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
					};
					let latestCacheHitRate: number | null = null;
					for (const entry of ctx.sessionManager.getEntries()) {
						const record = entry as {
							type?: string;
							message?: { role?: string; usage?: unknown };
							usage?: unknown;
						};
						if (record.type === "message" && record.message?.role === "assistant") {
							addUsage(totals, record.message.usage);
							const usage = record.message.usage as {
								input?: number;
								cacheRead?: number;
								cacheWrite?: number;
							};
							const promptTokens =
								(usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
							if (promptTokens > 0) {
								latestCacheHitRate = ((usage?.cacheRead ?? 0) / promptTokens) * 100;
							}
						} else if (record.type === "message" && record.message?.role === "toolResult") {
							addUsage(totals, record.message.usage);
						} else if (record.type === "branch_summary" || record.type === "compaction") {
							addUsage(totals, record.usage);
						}
					}

					const pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					const sessionName = pi.getSessionName();
					const pwdLine =
						theme.fg("dim", pwd) +
						(branch ? theme.fg("accent", ` (${branch})`) : "") +
						(sessionName ? theme.fg("dim", ` • ${sessionName}`) : "");

					const modelName = ctx.model?.id || "no-model";
					const provider = footerData.getAvailableProviderCount() > 1 && ctx.model
						? `(${ctx.model.provider}) `
						: "";
					const model = modelLabel(
						provider,
						modelName,
						ctx.thinkingLevel,
						ctx.model?.reasoning,
						theme,
					);
					const firstLine = truncateToWidth(pwdLine, width, theme.fg("dim", "..."));

					const stats = [model];
					const metric = (text: string): string => theme.fg("dim", text);
					if (totals.input) stats.push(metric(`↑${formatTokens(totals.input)}`));
					if (totals.output) stats.push(metric(`↓${formatTokens(totals.output)}`));
					if (totals.cacheRead) stats.push(metric(`R${formatTokens(totals.cacheRead)}`));
					if (totals.cacheWrite) stats.push(metric(`W${formatTokens(totals.cacheWrite)}`));
					if (latestCacheHitRate !== null) stats.push(metric(`CH${latestCacheHitRate.toFixed(1)}%`));
					if (totals.cost) stats.push(metric(`$${totals.cost.toFixed(3)}`));

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercent = contextUsage?.percent;
					const auto = " (auto)";
					const contextText =
						contextPercent === null || contextPercent === undefined
							? `?/${formatTokens(contextWindow)}${auto}`
							: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}${auto}`;
					stats.push(metric(contextText));

					let line = stats.join(" ");
					if (visibleWidth(line) > width) line = truncateToWidth(line, width, "...");
					return [firstLine, line];
				},
			};
		});
	});
}
