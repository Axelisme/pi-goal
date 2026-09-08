export type ExpectedWakeBy = "user" | "event";

export type WaitPolicyReason = "user_away_prior" | "insufficient_evidence";

export type WaitPolicyDecision = {
	action: "wait";
	reason: WaitPolicyReason;
};

/**
 * Decide the conservative action for one explicit expected wake source.
 *
 * This first tracer deliberately has no scheduling or paid-heartbeat variant: a
 * user wait assumes the user is away, while an event wait lacks calibrated forecast
 * and complete cost evidence. The caller owns persistence, observations, lifecycle,
 * timers, messages, and Pi context; this pure policy owns none of those effects.
 * Unknown wake provenance is handled by runtime observation and never inferred here.
 */
export function decideWait(expectWakeBy: ExpectedWakeBy): WaitPolicyDecision {
	return expectWakeBy === "user"
		? { action: "wait", reason: "user_away_prior" }
		: { action: "wait", reason: "insufficient_evidence" };
}

export function normalizeExpectedWakeBy(value: unknown): ExpectedWakeBy | null {
	return value === "user" || value === "event" ? value : null;
}
