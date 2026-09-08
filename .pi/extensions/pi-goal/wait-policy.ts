export type ExpectedWakeBy = "user" | "event";

export type WaitPolicyReason = "user_away_prior" | "insufficient_evidence";

export type WaitPolicyDecision = {
	action: "wait";
	reason: WaitPolicyReason;
};

/**
 * Decide whether the runtime should buy another wake while a goal is yielded.
 *
 * This first tracer deliberately has no scheduling variant: user waits assume the
 * user is away, while event waits lack the calibrated forecast and complete cost
 * evidence needed to justify a paid request. The caller owns persistence, timers,
 * messages, and Pi context; this policy owns none of those effects.
 */
export function decideWait(expectWakeBy: ExpectedWakeBy): WaitPolicyDecision {
	return expectWakeBy === "user"
		? { action: "wait", reason: "user_away_prior" }
		: { action: "wait", reason: "insufficient_evidence" };
}

export function normalizeExpectedWakeBy(value: unknown): ExpectedWakeBy | null {
	return value === "user" || value === "event" ? value : null;
}
