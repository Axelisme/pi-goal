const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	accountGoalTurn,
	countYieldTimeout,
	createGoalState,
	endWaitSequence,
	formatElapsed,
	enforceYieldBatch,
	normalizeYieldReason,
	restoreGoalState,
	yieldGoalState,
	resumeGoalState,
	formatTokens,
	goalEventStatus,
	goalUsage,
	normalizeTokenBudget,
	normalizeYieldTimeoutSeconds,
	parseTokenBudget,
	statusLine,
	truncateObjective,
	waitElapsedSeconds,
} = jiti("../.pi/extensions/pi-goal/goal-state.ts");

test("parseTokenBudget returns trimmed objective with no budget", () => {
	assert.deepEqual(parseTokenBudget("  finish the migration  "), {
		objective: "finish the migration",
		tokenBudget: null,
	});
});

test("parseTokenBudget accepts equals, spaces, decimals, k, and m", () => {
	assert.deepEqual(parseTokenBudget("--tokens=50k finish migration"), {
		objective: "finish migration",
		tokenBudget: 50_000,
	});
	assert.deepEqual(parseTokenBudget("finish --tokens 1.5m migration"), {
		objective: "finish migration",
		tokenBudget: 1_500_000,
	});
	assert.deepEqual(parseTokenBudget("finish --tokens 250 migration"), {
		objective: "finish migration",
		tokenBudget: 250,
	});
});

test("parseTokenBudget preserves objective and reports invalid budget", () => {
	assert.deepEqual(parseTokenBudget("ship --tokens 0 now"), {
		objective: "ship --tokens 0 now",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
});

test("parseTokenBudget reports invalid explicit token flag values", () => {
	assert.deepEqual(parseTokenBudget("ship --tokens soon"), {
		objective: "ship --tokens soon",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
	assert.deepEqual(parseTokenBudget("ship --tokens -5 now"), {
		objective: "ship --tokens -5 now",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
});

test("normalizeTokenBudget accepts absent and positive numeric values", () => {
	assert.deepEqual(normalizeTokenBudget(undefined), { tokenBudget: null });
	assert.deepEqual(normalizeTokenBudget(null), { tokenBudget: null });
	assert.deepEqual(normalizeTokenBudget("1500.4"), { tokenBudget: 1500 });
	assert.deepEqual(normalizeTokenBudget(1500.6), { tokenBudget: 1501 });
});

test("normalizeTokenBudget rejects non-positive and non-numeric values", () => {
	assert.deepEqual(normalizeTokenBudget(0), {
		tokenBudget: null,
		error: "tokenBudget must be a positive number when provided.",
	});
	assert.deepEqual(normalizeTokenBudget("nope"), {
		tokenBudget: null,
		error: "tokenBudget must be a positive number when provided.",
	});
});

test("yield timeout defaults to five minutes and enforces finite integer bounds", () => {
	assert.deepEqual(normalizeYieldTimeoutSeconds(undefined), { timeoutSeconds: 300 });
	assert.deepEqual(normalizeYieldTimeoutSeconds(30), { timeoutSeconds: 30 });
	assert.deepEqual(normalizeYieldTimeoutSeconds(600), { timeoutSeconds: 600 });
	for (const value of [0, 29, 601, 30.5, Number.NaN, Number.POSITIVE_INFINITY, "300"]) {
		assert.deepEqual(normalizeYieldTimeoutSeconds(value), {
			timeoutSeconds: null,
			error: "timeoutSeconds must be an integer between 30 and 600 seconds.",
		});
	}
});

test("formatTokens uses compact K and M suffixes", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1K");
	assert.equal(formatTokens(12_340), "12.3K");
	assert.equal(formatTokens(1_250_000), "1.3M");
});

test("formatElapsed keeps seconds, minutes, and hours readable", () => {
	assert.equal(formatElapsed(59), "59s");
	assert.equal(formatElapsed(60), "1m");
	assert.equal(formatElapsed(3_599), "59m");
	assert.equal(formatElapsed(3_600), "1h");
	assert.equal(formatElapsed(5_460), "1h 31m");
});

test("statusLine covers all lifecycle states", () => {
	assert.equal(statusLine(null), undefined);
	assert.equal(statusLine({ status: "active", tokenBudget: 1000, tokensUsed: 500, timeUsedSeconds: 10 }), "Pursuing goal (500 / 1K)");
	assert.equal(statusLine({ status: "yielded", yieldReason: "waiting for provider", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 10 }), "Goal yielded: waiting for provider");
	assert.equal(statusLine({ status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 10 }), "Goal paused (/goal resume)");
	assert.equal(statusLine({ status: "budget_limited", tokenBudget: 1000, tokensUsed: 1000, timeUsedSeconds: 10 }), "Goal unmet (1K / 1K)");
	assert.equal(statusLine({ status: "budget_limited", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 10 }), "Goal abandoned");
	assert.equal(statusLine({ status: "complete", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 61 }), "Goal achieved (1m)");
});

test("goalUsage prefers token budget usage when budgeted", () => {
	assert.equal(goalUsage({ tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 99 }), "250 / 1K tokens");
	assert.equal(goalUsage({ tokenBudget: null, tokensUsed: 250, timeUsedSeconds: 99 }), "1m");
});

test("truncateObjective collapses whitespace and truncates at max", () => {
	assert.equal(truncateObjective("  one\n two\tthree  "), "one two three");
	assert.equal(truncateObjective("abcdef", 4), "abc…");
});

test("goalEventStatus maps event kinds to display labels", () => {
	assert.equal(goalEventStatus("active"), "active");
	assert.equal(goalEventStatus("continuation"), "continuing");
	assert.equal(goalEventStatus("yielded"), "yielded");
	assert.equal(goalEventStatus("yield_timeout"), "yield timed out");
	assert.equal(goalEventStatus("budget_limited"), "budget reached");
	assert.equal(goalEventStatus("complete"), "achieved");
});

test("createGoalState creates a deterministic active goal when time and random are supplied", () => {
	assert.deepEqual(createGoalState("ship it", 123, 42, 0.5), {
		version: 3,
		id: "42-8",
		objective: "ship it",
		status: "active",
		tokenBudget: 123,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 42,
		updatedAt: 42,
	});
});

test("older state migrates losslessly and arrives with no open wait sequence", () => {
	for (const version of [1, 2]) {
		const restored = restoreGoalState({ version, id: "old", objective: "keep going", status: "active", tokenBudget: null, tokensUsed: 2, timeUsedSeconds: 3, createdAt: 4, updatedAt: 5 });
		assert.equal(restored.migrated, true, `v${version}`);
		assert.equal(restored.goal.version, 3, `v${version}`);
		assert.equal(restored.goal.status, "active", `v${version}`);
		assert.equal(restored.goal.waitStartedAt, undefined, `v${version}`);
		assert.equal(waitElapsedSeconds(restored.goal, 9_000), 0, `v${version}`);
	}
	assert.equal(restoreGoalState({ version: 99 }).goal, null);
});

test("a restored v3 record keeps its wait sequence", () => {
	const restored = restoreGoalState({
		version: 3, id: "waiting", objective: "await a child", status: "yielded", yieldReason: "child running",
		yieldedAt: 5_000, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 5_000,
		waitStartedAt: 1_000, waitTimeouts: 4,
	});
	assert.equal(restored.migrated, false);
	assert.equal(restored.goal.waitStartedAt, 1_000);
	assert.equal(restored.goal.waitTimeouts, 4);
	assert.equal(waitElapsedSeconds(restored.goal, 61_000), 60);
});

test("a wait sequence spans timeouts and ends only when it is ended", () => {
	const goal = createGoalState("await a child", null, 1_000, 0.5);
	const first = yieldGoalState(goal, "child running", 2_000);
	assert.equal(first.waitStartedAt, 2_000);
	assert.equal(first.waitTimeouts, 0);

	const woken = countYieldTimeout(first, 302_000);
	assert.equal(woken.waitTimeouts, 1);
	assert.equal(waitElapsedSeconds(woken, 302_000), 300);

	// A timeout recheck resumes and re-yields; the sequence is one wait, not two.
	const reYielded = yieldGoalState(resumeGoalState(woken, 302_100), "child still running", 302_200);
	assert.equal(reYielded.waitStartedAt, 2_000);
	assert.equal(reYielded.waitTimeouts, 1);
	assert.equal(countYieldTimeout(reYielded, 602_000).waitTimeouts, 2);

	// A real external wake ends the sequence, so the next yield starts a fresh one.
	const external = endWaitSequence(resumeGoalState(reYielded, 400_000));
	assert.equal(external.waitStartedAt, undefined);
	assert.equal(external.waitTimeouts, undefined);
	const restarted = yieldGoalState(external, "a different prerequisite", 401_000);
	assert.equal(restarted.waitStartedAt, 401_000);
	assert.equal(restarted.waitTimeouts, 0);
});

test("budget exhaustion ends the wait sequence with the goal", () => {
	const goal = { ...createGoalState("await a child", 10, 1_000, 0.5), status: "active" };
	const yielded = yieldGoalState(goal, "child running", 2_000);
	const limited = accountGoalTurn(countYieldTimeout(yielded, 3_000), 10, 1, 4_000);
	assert.equal(limited.status, "budget_limited");
	assert.equal(limited.waitStartedAt, undefined);
	assert.equal(limited.waitTimeouts, undefined);
});

test("yield transition validates and bounds a diagnostic reason", () => {
	const goal = createGoalState("ship it", null, 42, 0.5);
	const yielded = yieldGoalState(goal, "  waiting\\nfor provider " + "x".repeat(300), 50);
	assert.equal(yielded.status, "yielded");
	assert.equal(yielded.yieldReason.length, 240);
	assert.equal(yieldGoalState(yielded, "again"), null);
	assert.equal(normalizeYieldReason("  \n"), undefined);
	assert.equal(resumeGoalState(yielded, 60).status, "active");
});

test("yield wins terminal tool batches deterministically", () => {
	const message = { role: "assistant", content: [
		{ type: "text", text: "handoff" },
		{ type: "toolCall", name: "bash", id: "b" },
		{ type: "toolCall", name: "yield_goal", id: "y1" },
		{ type: "toolCall", name: "yield_goal", id: "y2" },
	] };
	const result = enforceYieldBatch([message])[0];
	assert.deepEqual(result.content.map((part) => part.name).filter(Boolean), ["yield_goal"]);
	assert.equal(result.content.find((part) => part.name === "yield_goal").id, "y1");
});

test("accountGoalTurn adds usage and marks active budgeted goals budget-limited", () => {
	const goal = createGoalState("ship it", 100, 42, 0.5);
	assert.deepEqual(accountGoalTurn(goal, 70, 5, 50), {
		...goal,
		tokensUsed: 70,
		timeUsedSeconds: 5,
		updatedAt: 50,
		status: "active",
	});
	assert.equal(accountGoalTurn(goal, 100, 5, 50).status, "budget_limited");
});

test("yield usage is charged and budget exhaustion takes precedence", () => {
	const yielded = yieldGoalState(createGoalState("ship it", 10, 42, 0.5), "waiting", 45);
	const limited = accountGoalTurn(yielded, 10, 2, 50);
	assert.equal(limited.status, "budget_limited");
	assert.equal(limited.tokensUsed, 10);
});

test("accountGoalTurn preserves complete status while charging final turn usage", () => {
	const completed = { ...createGoalState("ship it", 100, 42, 0.5), status: "complete" };
	assert.deepEqual(accountGoalTurn(completed, 25, 7, 55), {
		...completed,
		tokensUsed: 25,
		timeUsedSeconds: 7,
		updatedAt: 55,
		status: "complete",
	});
});

test("accountGoalTurn clamps negative usage deltas", () => {
	const goal = createGoalState("ship it", null, 42, 0.5);
	assert.deepEqual(accountGoalTurn(goal, -25, -7, 55), {
		...goal,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		updatedAt: 55,
	});
});
