import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const MIN_PADDING = 2;

type FooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
};

type FooterTheme = {
	fg(color: string, text: string): string;
};

type FooterTui = {
	requestRender(): void;
};

type GoalFooterOptions = {
	statusKey: string;
	goalStatus(): string | undefined;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function compactTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function displayCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const insideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function addUsage(totals: UsageTotals, usage: any): void {
	if (!usage || typeof usage !== "object") return;
	totals.input += Number(usage.input) || 0;
	totals.output += Number(usage.output) || 0;
	totals.cacheRead += Number(usage.cacheRead) || 0;
	totals.cacheWrite += Number(usage.cacheWrite) || 0;
	totals.cost += Number(usage.cost?.total) || 0;
}

function usageTotals(ctx: ExtensionContext): { totals: UsageTotals; latestCacheHitRate?: number } {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries() as any[]) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const usage = entry.message.usage;
			addUsage(totals, usage);
			const promptTokens = (Number(usage?.input) || 0) + (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0);
			if (promptTokens > 0) latestCacheHitRate = ((Number(usage?.cacheRead) || 0) / promptTokens) * 100;
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			addUsage(totals, entry.message.usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
		}
	}
	return { totals, latestCacheHitRate };
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function nativeStatusLine(ctx: ExtensionContext, theme: FooterTheme, footerData: FooterData, width: number): string {
	const { totals, latestCacheHitRate } = usageTotals(ctx);
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${compactTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${compactTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${compactTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${compactTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercent = usage?.percent;
	const contextDisplay = contextPercent == null ? `?/${compactTokens(contextWindow)} (auto)` : `${contextPercent.toFixed(1)}%/${compactTokens(contextWindow)} (auto)`;
	parts.push(contextPercent != null && contextPercent > 90
		? theme.fg("error", contextDisplay)
		: contextPercent != null && contextPercent > 70
			? theme.fg("warning", contextDisplay)
			: contextDisplay);

	let left = parts.join(" ");
	if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
	let rightWithoutProvider = ctx.model?.id ?? "no-model";
	if (ctx.model?.reasoning) rightWithoutProvider += ctx.thinkingLevel === "off" ? " • thinking off" : ` • ${ctx.thinkingLevel}`;
	let right = rightWithoutProvider;
	if (ctx.model && footerData.getAvailableProviderCount() > 1) {
		const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
		if (visibleWidth(left) + MIN_PADDING + visibleWidth(withProvider) <= width) right = withProvider;
	}
	const availableForRight = width - visibleWidth(left) - MIN_PADDING;
	if (availableForRight <= 0) return theme.fg("dim", left);
	right = truncateToWidth(right, availableForRight, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
	return theme.fg("dim", left) + theme.fg("dim", padding + right);
}

export function createGoalFooter(
	ctx: ExtensionContext,
	tui: FooterTui,
	theme: FooterTheme,
	footerData: FooterData,
	options: GoalFooterOptions,
) {
	const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
	return {
		dispose: unsubscribe,
		invalidate() {},
		render(width: number): string[] {
			let pwd = displayCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
			const branch = footerData.getGitBranch();
			if (branch) pwd += ` (${branch})`;
			const sessionName = (ctx.sessionManager as any).getSessionName?.();
			if (sessionName) pwd += ` • ${sessionName}`;

			const lines = [
				truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
				nativeStatusLine(ctx, theme, footerData, width),
			];
			const sharedStatuses = Array.from(footerData.getExtensionStatuses().entries())
				.filter(([key]) => key !== options.statusKey)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatus(text))
				.filter(Boolean);
			if (sharedStatuses.length) lines.push(truncateToWidth(sharedStatuses.join(" "), width, theme.fg("dim", "...")));
			const goalStatus = options.goalStatus();
			if (goalStatus) lines.push(truncateToWidth(sanitizeStatus(goalStatus), width, theme.fg("dim", "...")));
			return lines;
		},
	};
}
