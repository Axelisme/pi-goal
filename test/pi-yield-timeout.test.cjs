const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };

function makeHarness({ runtimeSupport = false, contextTokens, entries = [], idle = true, pending = false } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const sent = [];
	const notices = [];
	const compactions = [];
	let activeTools = ["create_goal"];
	let appendThrows = false;
	let compactThrows = false;
	let isIdle = idle;
	let hasPendingMessages = pending;
	let tokens = contextTokens;
	let nextEntryId = entries.length;
	let leafId = entries.at(-1)?.id ?? null;

	function branch() {
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const result = [];
		let cursor = leafId;
		while (cursor) {
			const entry = byId.get(cursor);
			if (!entry) break;
			result.unshift(entry);
			cursor = entry.parentId;
		}
		return result;
	}

	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) { sent.push({ message, options: sendOptions }); },
		appendEntry(customType, data) {
			if (appendThrows) throw new Error("durability unavailable");
			nextEntryId += 1;
			const entry = { id: `e${nextEntryId}`, parentId: leafId, type: "custom", customType, data };
			entries.push(entry);
			leafId = entry.id;
		},
		getActiveTools() { return activeTools; },
		setActiveTools(next) { activeTools = next; },
	};
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch(),
			getLeafId: () => leafId,
		},
		ui: {
			setStatus() {},
			notify(message) { notices.push(String(message)); },
			confirm: async () => true,
		},
		isIdle: () => isIdle,
		hasPendingMessages: () => hasPendingMessages,
	};
	if (runtimeSupport) {
		ctx.getContextUsage = () => tokens === undefined ? undefined : { tokens, contextWindow: 200_000 };
		ctx.compact = (callbacks) => {
			compactions.push(callbacks);
			if (compactThrows) throw new Error("compaction request failed");
		};
	}
	return {
		pi, ctx, handlers, tools, commands, entries, sent, notices, compactions,
		branchEntries: () => branch(),
		setAppendThrows(value) { appendThrows = value; },
		setCompactThrows(value) { compactThrows = value; },
		setContextTokens(value) { tokens = value; },
		setIdle(value) { isIdle = value; },
		setPending(value) { hasPendingMessages = value; },
	};
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-yield-timeout.test.cjs"), {
		moduleCache: false,
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	return jiti("../.pi/extensions/pi-goal/index.ts").default;
}

async function install(h, reason = "startup") {
	loadExtension()(h.pi);
	await h.handlers.get("session_start")({ reason }, h.ctx);
}

function lastGoal(h) {
	for (let i = h.entries.length - 1; i >= 0; i--) {
		if (h.entries[i].customType === "pi-goal") return h.entries[i].data?.goal;
	}
	return undefined;
}

function observations(h) {
	return h.entries.filter((entry) => entry.customType === "pi-goal-observation").map((entry) => entry.data);
}

async function createGoal(h, objective = "await a child") {
	return h.tools.get("create_goal").execute("create", { objective }, null, null, h.ctx);
}

async function yieldGoal(h, expectWakeBy = "event", reason = "child running", extra = {}) {
	return h.tools.get("yield_goal").execute("yield", { reason, expect_wake_by: expectWakeBy, ...extra }, null, null, h.ctx);
}

async function waitForSettlement(h) {
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await Promise.resolve();
}

test("a yielded goal stays quiet across multiple approved cache windows", options, async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	h.sent.length = 0;
	const result = await yieldGoal(h, "event");
	assert.equal(result.terminate, true);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0);
	// Advancing two approved windows still has no runtime operation or synthetic
	// request in this tracer.
	t.mock.timers.tick(270_000);
	t.mock.timers.tick(270_000);
	assert.equal(h.sent.length, 0, "no fallback or diagnostic timer may manufacture a request");
	assert.equal(lastGoal(h).status, "yielded");
});

test("invalid yield input is rejected before wait or permission mutation", options, async () => {
	const cases = [
		{ params: { reason: "missing source" }, error: /expect_wake_by is required/ },
		{ params: { reason: "bad source", expect_wake_by: "rpc" }, error: /expect_wake_by is required/ },
		{ params: { reason: "legacy timeout", expect_wake_by: "event", timeoutSeconds: 270 }, error: /timeoutSeconds is no longer supported/ },
		{ params: { reason: "bad token", expect_wake_by: "event", discardToken: 3 }, error: /discardToken must be/ },
	];
	for (const current of cases) {
		const h = makeHarness();
		await install(h);
		await createGoal(h);
		const beforeEntries = h.entries.length;
		await assert.rejects(h.tools.get("yield_goal").execute("yield", current.params, null, null, h.ctx), current.error);
		assert.equal(lastGoal(h).status, "active", current.error);
		assert.equal(h.entries.length, beforeEntries, "invalid input has no durable or observation side effect");
		assert.equal(h.sent.length, 1, "only create_goal's active marker exists");
	}
});

test("a valid discardToken-shaped input cannot create rewind authority without a runtime recheck", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	const result = await yieldGoal(h, "event", "waiting", { discardToken: "not-issued" });
	const payload = JSON.parse(result.content[0].text);
	assert.deepEqual(payload.discard, {
		requested: true,
		accepted: false,
		reason: "no fallback timeout wake is open for this goal",
	});
	assert.equal(lastGoal(h).status, "yielded");
});

test("wait observations are paired, bounded, and excluded from the provider conversation", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h, "objective must not enter observation");
	await yieldGoal(h, "event", "reason must not enter observation");
	const started = observations(h);
	assert.deepEqual(started.map((entry) => entry.kind), ["wait_started", "policy_decision"]);
	assert.equal(started[0].waitId, lastGoal(h).waitId);
	assert.equal(started[1].reasonCode, "insufficient_evidence");
	for (const entry of started) {
		assert.equal("objective" in entry, false);
		assert.equal("reason" in entry, false);
		assert.equal("content" in entry, false);
		assert.equal(entry.goalId, lastGoal(h).id);
	}

	h.handlers.get("input")({ type: "input", source: "extension", text: "notification" }, h.ctx);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	const ended = observations(h).at(-1);
	assert.equal(ended.kind, "wait_ended");
	assert.equal(ended.waitId, started[0].waitId);
	assert.equal(ended.wakeSource, "unknown");
	assert.equal(ended.terminationReason, "native_wake");
	assert.equal(lastGoal(h).waitId, undefined);
});

test("only interactive input is labelled as a user wake", options, async () => {
	for (const source of ["rpc", "extension", undefined]) {
		const h = makeHarness();
		await install(h);
		await createGoal(h);
		await yieldGoal(h, "user", "waiting for a person");
		if (source) h.handlers.get("input")({ type: "input", source, text: "wake" }, h.ctx);
		await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
		assert.equal(observations(h).at(-1).wakeSource, "unknown", source ?? "missing source");
	}
	const interactive = makeHarness();
	await install(interactive);
	await createGoal(interactive);
	await yieldGoal(interactive, "event");
	interactive.handlers.get("input")({ type: "input", source: "interactive", text: "wake" }, interactive.ctx);
	await interactive.handlers.get("turn_start")({ type: "turn_start" }, interactive.ctx);
	assert.equal(observations(interactive).at(-1).wakeSource, "user");
});

test("/goal status reports the expected source and quiet heartbeat state", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "user", "waiting for approval");
	await h.commands.get("goal").handler("status", h.ctx);
	assert.match(h.notices.at(-1), /Expected wake: user/);
	assert.match(h.notices.at(-1), /Heartbeat: waiting without heartbeat/);
	assert.match(h.notices.at(-1), /Wait id:/);
});

test("native wake ends the wait before provider work without adding a resume marker", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event");
	h.sent.length = 0;
	h.handlers.get("input")({ type: "input", source: "interactive", text: "the event completed" }, h.ctx);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(h.sent.length, 0);
	assert.equal(observations(h).filter((entry) => entry.kind === "wait_ended").length, 1);
});

test("yield settlement keeps native compaction ordering and never adds a heartbeat", options, async () => {
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await createGoal(h);
	h.sent.length = 0;
	await yieldGoal(h, "event", "compact after handoff");
	assert.equal(h.compactions.length, 0, "yield does not compact inside its own tool call");
	await waitForSettlement(h);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 0);
	h.compactions[0].onComplete({});
	h.compactions[0].onComplete({});
	assert.equal(h.sent.length, 0);
});

test("settlement waits for idle and rechecks context usage", options, async () => {
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000, idle: false });
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event");
	await waitForSettlement(h);
	assert.equal(h.compactions.length, 0);
	h.setIdle(true);
	await waitForSettlement(h);
	assert.equal(h.compactions.length, 1);

	const below = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(below);
	await createGoal(below);
	await yieldGoal(below, "event");
	below.setContextTokens(100_000);
	await waitForSettlement(below);
	assert.equal(below.compactions.length, 0);
});

test("create_goal replacement closes a yielded wait before replacing it", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h, "old objective");
	await yieldGoal(h, "event");
	const oldWaitId = lastGoal(h).waitId;
	await createGoal(h, "new objective");
	const ended = observations(h).find((entry) => entry.kind === "wait_ended" && entry.waitId === oldWaitId);
	assert.equal(ended.terminationReason, "replaced");
	assert.equal(lastGoal(h).objective, "new objective");
	assert.equal(lastGoal(h).status, "active");
});

test("reload, pause, clear, replacement, and shutdown close a yielded wait safely", options, async () => {
	for (const transition of ["pause", "clear", "replace", "reload", "shutdown"]) {
		const h = makeHarness();
		await install(h);
		await createGoal(h, transition);
		await yieldGoal(h, "event");
		const waitId = lastGoal(h).waitId;
		if (transition === "pause") await h.commands.get("goal").handler("pause", h.ctx);
		if (transition === "clear") await h.commands.get("goal").handler("clear", h.ctx);
		if (transition === "replace") await h.commands.get("goal").handler("replacement", h.ctx);
		if (transition === "reload") await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
		if (transition === "shutdown") await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
		const end = observations(h).find((entry) => entry.kind === "wait_ended" && entry.waitId === waitId);
		assert.ok(end, transition);
		assert.equal(end.wakeSource, "unknown");
		if (transition === "clear") assert.equal(lastGoal(h), null);
		else assert.notEqual(lastGoal(h).status, "yielded");
	}
});

test("a yielded goal restored from an older version is paused without guessing its source", options, async () => {
	const legacy = {
		version: 3,
		id: "legacy-wait",
		objective: "retain this objective",
		status: "yielded",
		tokenBudget: null,
		tokensUsed: 4,
		timeUsedSeconds: 5,
		createdAt: 1,
		updatedAt: 2,
		yieldReason: "old wait",
		yieldedAt: 2,
		waitStartedAt: 2,
		waitTimeouts: 3,
	};
	const h = makeHarness({ entries: [{ id: "legacy", type: "custom", customType: "pi-goal", data: { goal: legacy } }] });
	await install(h, "startup");
	assert.equal(lastGoal(h).status, "paused");
	assert.equal(lastGoal(h).objective, legacy.objective);
	assert.equal(lastGoal(h).tokensUsed, legacy.tokensUsed);
	assert.equal(lastGoal(h).expectWakeBy, undefined);
	assert.equal(observations(h).some((entry) => entry.wakeSource === "user" || entry.wakeSource === "event"), false);
});
