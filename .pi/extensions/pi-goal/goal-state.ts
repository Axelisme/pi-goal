export type GoalStatus = "active" | "yielded" | "paused" | "budget_limited" | "complete";

export const GOAL_STATE_VERSION = 5 as const;
export const MAX_YIELD_REASON_LENGTH = 240;

export type GoalState = {
	version: 5;
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	yieldReason?: string;
	yieldedAt?: number;
	// The current wait sequence starts at the first yield and ends when a real external
	// event wakes the goal or its lifecycle is terminated. Legacy restored records may
	// lack identity until a fresh explicit yield starts a new observable wait.
	waitId?: string;
	waitStartedAt?: number;
	waitTimeouts?: number;
};

export type GoalEventKind = "active" | "continuation" | "yielded" | "paused" | "resumed" | "cleared" | "budget_limited" | "complete";

const VALID_STATUSES = new Set<GoalStatus>(["active", "yielded", "paused", "budget_limited", "complete"]);
let waitSequenceCounter = 0;

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Normalize model-provided diagnostic data; it is never an authority signal. */
export function normalizeYieldReason(value: unknown, max = MAX_YIELD_REASON_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const reason = value.replace(/\s+/g, " ").trim();
	if (!reason) return undefined;
	const bounded = Math.max(1, Math.floor(max));
	return reason.length > bounded ? `${reason.slice(0, bounded - 1)}…` : reason;
}

export type RestoreGoalResult = { goal: GoalState | null; diagnostic?: string; migrated: boolean };

/** Convenience state-only migration seam for callers that do not need diagnostics. */
export function migrateGoalState(value: unknown): GoalState | null {
	return restoreGoalState(value).goal;
}

/** Restore only known, structurally valid records. Invalid persistence is non-autonomous. */
export function restoreGoalState(value: unknown): RestoreGoalResult {
	if (!value || typeof value !== "object") return { goal: null, diagnostic: "Goal state is not an object.", migrated: false };
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3 && raw.version !== 4 && raw.version !== GOAL_STATE_VERSION) {
		return { goal: null, diagnostic: `Unsupported goal state version: ${String(raw.version)}.`, migrated: false };
	}
	if (typeof raw.id !== "string" || !raw.id || typeof raw.objective !== "string" || !raw.objective.trim()) {
		return { goal: null, diagnostic: "Goal state is missing a valid id or objective.", migrated: false };
	}
	if (!VALID_STATUSES.has(raw.status as GoalStatus) || raw.status === "yielded" && !normalizeYieldReason(raw.yieldReason)) {
		return { goal: null, diagnostic: "Goal state has an invalid status or yield reason.", migrated: false };
	}
	const budget = raw.tokenBudget;
	if (budget !== null && !finiteNonNegative(budget) || !finiteNonNegative(raw.tokensUsed) || !finiteNonNegative(raw.timeUsedSeconds) || !finiteNonNegative(raw.createdAt) || !finiteNonNegative(raw.updatedAt)) {
		return { goal: null, diagnostic: "Goal state has malformed accounting fields.", migrated: false };
	}
	const base: GoalState = {
		version: GOAL_STATE_VERSION,
		id: raw.id,
		objective: raw.objective,
		status: raw.status as GoalStatus,
		tokenBudget: budget as number | null,
		tokensUsed: raw.tokensUsed as number,
		timeUsedSeconds: raw.timeUsedSeconds as number,
		createdAt: raw.createdAt as number,
		updatedAt: raw.updatedAt as number,
	};
	if (base.status === "yielded") {
		base.yieldReason = normalizeYieldReason(raw.yieldReason)!;
		base.yieldedAt = finiteNonNegative(raw.yieldedAt) ? raw.yieldedAt : base.updatedAt;
	}

	const hasWaitData = ["waitId", "waitStartedAt", "waitTimeouts"].some((key) => raw[key] !== undefined);
	const hasWaitStart = finiteNonNegative(raw.waitStartedAt);
	if (raw.version === GOAL_STATE_VERSION && (base.status === "yielded" || hasWaitData)) {
		const validWaitCount = raw.waitTimeouts === undefined || Number.isInteger(raw.waitTimeouts) && finiteNonNegative(raw.waitTimeouts);
		const validWaitIdentity = typeof raw.waitId === "string" && raw.waitId.length > 0;
		if (!hasWaitStart || !validWaitCount || !validWaitIdentity) {
			return { goal: null, diagnostic: "Goal state has malformed observable wait fields.", migrated: false };
		}
		base.waitId = raw.waitId;
		base.waitStartedAt = raw.waitStartedAt;
		base.waitTimeouts = raw.waitTimeouts === undefined ? 0 : raw.waitTimeouts;
	} else if (hasWaitStart) {
		// v1-v4 wait history is retained, but its identity is unknown. A restored
		// yielded record is paused by the runtime before it can acquire authority.
		base.waitStartedAt = raw.waitStartedAt;
		base.waitTimeouts = Number.isInteger(raw.waitTimeouts) && finiteNonNegative(raw.waitTimeouts) ? raw.waitTimeouts : 0;
	}
	return { goal: base, migrated: raw.version !== GOAL_STATE_VERSION };
}

export function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+\s*[kKmM]?)(?:\s|$)/);
	if (!match) return { objective: input.trim(), tokenBudget: null };

	const raw = match[1].replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) {
		return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
	}
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokenBudget = Math.round(value * multiplier);
	const objective = (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim();
	return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): { tokenBudget: number | null; error?: string } {
	if (value == null) return { tokenBudget: null };
	const tokenBudget = Math.round(Number(value));
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
		return { tokenBudget: null, error: "tokenBudget must be a positive number when provided." };
	}
	return { tokenBudget };
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const budget = state.tokenBudget ? ` (${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)})` : ` (${formatElapsed(state.timeUsedSeconds)})`;
	if (state.status === "active") return `Pursuing goal${budget}`;
	if (state.status === "yielded") return `Goal yielded: ${normalizeYieldReason(state.yieldReason, 64) ?? "external prerequisite"}`;
	if (state.status === "paused") return "Goal paused (/goal resume)";
	if (state.status === "budget_limited") return state.tokenBudget ? `Goal unmet${budget}` : "Goal abandoned";
	return `Goal achieved${budget}`;
}

export function goalUsage(state: GoalState): string {
	if (state.tokenBudget != null) return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
	return formatElapsed(state.timeUsedSeconds);
}

export function truncateObjective(objective: string, max = 96): string {
	const singleLine = objective.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export function goalEventStatus(kind: GoalEventKind): string {
	const labels: Record<GoalEventKind, string> = {
		active: "active",
		continuation: "continuing",
		yielded: "yielded",
		paused: "paused",
		resumed: "resumed",
		cleared: "cleared",
		budget_limited: "budget reached",
		complete: "achieved",
	};
	return labels[kind];
}

export function createGoalState(objective: string, tokenBudget: number | null, now = Date.now(), random = Math.random()): GoalState {
	return {
		version: GOAL_STATE_VERSION,
		id: `${now}-${random.toString(16).slice(2)}`,
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Open a wait owned by this goal. A re-yield before the wait is ended keeps the
 * wait identity, start time, and historical fallback count. This transition is
 * pure and does not infer wake provenance from the diagnostic reason.
 */
export function yieldGoalState(state: GoalState, reason: unknown, now = Date.now()): GoalState | null {
	const normalized = normalizeYieldReason(reason);
	if (state.status !== "active" || !normalized) return null;
	const sameWait = state.waitStartedAt != null && state.waitId != null;
	const waitStartedAt = sameWait ? state.waitStartedAt! : now;
	const waitTimeouts = sameWait ? state.waitTimeouts ?? 0 : 0;
	const waitId = sameWait ? state.waitId! : `wait-${state.id}-${now}-${++waitSequenceCounter}`;
	return { ...state, version: GOAL_STATE_VERSION, status: "yielded", yieldReason: normalized, yieldedAt: now, updatedAt: now, waitId, waitStartedAt, waitTimeouts };
}

/** End the current wait sequence before a native wake or lifecycle boundary is persisted. */
export function endWaitSequence(state: GoalState): GoalState {
	if (state.waitStartedAt == null && state.waitTimeouts == null && state.waitId == null) return state;
	const next = { ...state, version: GOAL_STATE_VERSION };
	delete next.waitId;
	delete next.waitStartedAt;
	delete next.waitTimeouts;
	return next;
}

// Alias kept deliberately generic for consumers testing the public lifecycle seam.
export const transitionGoalToYielded = yieldGoalState;
export const createYieldedGoalState = yieldGoalState;

/** Resume only an explicit/native lifecycle wake; callers end a wait before persistence. */
export function resumeGoalState(state: GoalState, now = Date.now()): GoalState | null {
	if (state.status !== "yielded" && state.status !== "paused") return null;
	const next = { ...state, version: GOAL_STATE_VERSION, status: "active" as const, updatedAt: now };
	return next;
}

export function accountGoalTurn(state: GoalState, tokenDelta: number, elapsedSeconds: number, now = Date.now()): GoalState {
	let next: GoalState = {
		...state,
		version: GOAL_STATE_VERSION,
		tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
		updatedAt: now,
	};
	// The yield turn is charged too; budget exhaustion is the terminal winner.
	if ((next.status === "active" || next.status === "yielded") && next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
		next = endWaitSequence({ ...next, status: "budget_limited", yieldReason: undefined, yieldedAt: undefined });
	}
	return next;
}

export type ToolCallPart = { type: "toolCall"; name?: string; [key: string]: unknown };

/** Pure batch seam: a yielded tool call is the sole tool call in an assistant batch. */
export function enforceYieldExclusivity<T extends { role?: string; content?: unknown }>(message: T): T {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const calls = message.content.filter((part): part is ToolCallPart => !!part && typeof part === "object" && (part as any).type === "toolCall") as ToolCallPart[];
	const yieldCall = calls.find((call) => call.name === "yield_goal");
	if (!yieldCall) return message;
	return { ...message, content: message.content.filter((part) => !(part && typeof part === "object" && (part as any).type === "toolCall") || part === yieldCall) };
}

export function enforceYieldBatch<T extends { role?: string; content?: unknown }>(messages: T[]): T[] {
	let retainedYield = false;
	return messages.map((message) => {
		const transformed = enforceYieldExclusivity(message);
		if (transformed.role !== "assistant" || !Array.isArray(transformed.content)) return transformed;
		const hasYield = transformed.content.some((part) => !!part && typeof part === "object" && (part as any).type === "toolCall" && (part as any).name === "yield_goal");
		if (!hasYield) return transformed;
		if (!retainedYield) {
			retainedYield = true;
			return transformed;
		}
		return { ...transformed, content: transformed.content.filter((part) => !(part && typeof part === "object" && (part as any).type === "toolCall" && (part as any).name === "yield_goal")) };
	});
}

export function escapeUntrusted(value: unknown): string {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}
