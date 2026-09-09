const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };

function makeHarness({ runtimeSupport = false, contextTokens, entries = [], idle = true, pending = false } = {}) {
	const handlers = new Map();
	const inputHandlers = [];
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
		on(name, handler) {
			if (name === "input") inputHandlers.push(handler);
			handlers.set(name, handler);
		},
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
		addInputHandler(handler) { inputHandlers.push(handler); },
		async dispatchInput(event) {
			for (const handler of inputHandlers) {
				const result = await handler(event, ctx);
				if (result?.action === "handled") return result;
			}
			return { action: "continue" };
		},
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

async function yieldGoal(h, _ignoredSource = "event", reason = "child running", extra = {}) {
	return h.tools.get("yield_goal").execute("yield", { reason, ...extra }, null, null, h.ctx);
}

async function acceptedInput(h, source, text = "wake") {
	const result = await h.dispatchInput({ type: "input", source, text });
	assert.equal(result.action, "continue");
	await h.handlers.get("before_agent_start")({
		type: "before_agent_start",
		prompt: text,
		systemPrompt: "",
		systemPromptOptions: {},
	}, h.ctx);
}

async function waitForSettlement(h) {
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await Promise.resolve();
}

test("a yielded goal stays quiet as time passes", options, async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	h.sent.length = 0;
	const result = await yieldGoal(h, "event");
	assert.equal(result.terminate, true);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0);
	// Advancing time still has no runtime operation or synthetic request.
	t.mock.timers.tick(1_000);
	t.mock.timers.tick(1_000);
	assert.equal(h.sent.length, 0, "no fallback or diagnostic timer may manufacture a request");
	assert.equal(lastGoal(h).status, "yielded");
});

test("unsupported yield input is rejected before wait or permission mutation", options, async () => {
	const cases = [
		{ params: { reason: "legacy source", expect_wake_by: "event" } },
		{ params: { reason: "legacy source", expect_wake_by: "rpc" } },
		{ params: { reason: "legacy timeout", timeoutSeconds: 270 } },
		{ params: { reason: "legacy rewind", discardToken: 3 } },
	];
	for (const current of cases) {
		const h = makeHarness();
		await install(h);
		await createGoal(h);
		const beforeEntries = h.entries.length;
		await assert.rejects(h.tools.get("yield_goal").execute("yield", current.params, null, null, h.ctx), /Unsupported yield_goal parameter/);
		assert.equal(lastGoal(h).status, "active");
		assert.equal(h.entries.length, beforeEntries, "invalid input has no durable or observation side effect");
		assert.equal(h.sent.length, 1, "only create_goal's active marker exists");
	}
});

test("an unsupported rewind-shaped input cannot mutate the goal", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await assert.rejects(yieldGoal(h, "event", "waiting", { discardToken: "not-issued" }), /Unsupported yield_goal parameter/);
	assert.equal(lastGoal(h).status, "active");
});

test("wait observations are paired, bounded, and excluded from the provider conversation", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h, "objective must not enter observation");
	await yieldGoal(h, "event", "reason must not enter observation");
	const started = observations(h);
	assert.deepEqual(started.map((entry) => entry.kind), ["wait_started"]);
	assert.equal(started[0].waitId, lastGoal(h).waitId);
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
		await acceptedInput(h, source);
		await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
		assert.equal(observations(h).at(-1).wakeSource, "unknown", source ?? "missing source");
	}
	const interactive = makeHarness();
	await install(interactive);
	await createGoal(interactive);
	await yieldGoal(interactive, "event");
	await acceptedInput(interactive, "interactive");
	await interactive.handlers.get("turn_start")({ type: "turn_start" }, interactive.ctx);
	assert.equal(observations(interactive).at(-1).wakeSource, "user");
});

test("a handled interactive input cannot label an unrelated native wake", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event", "waiting for a handled prompt");

	// A later input handler consumes this prompt, so Pi emits neither
	// before_agent_start nor a turn for it.
	h.addInputHandler(() => ({ action: "handled" }));
	const handled = await h.dispatchInput({ type: "input", source: "interactive", text: "handled" });
	assert.equal(handled.action, "handled");

	// An unrelated native custom notification starts the next turn. Its source
	// was never correlated with the consumed prompt and must remain unknown.
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(observations(h).at(-1).wakeSource, "unknown");
});

test("a handled non-interactive input leaves a later accepted interactive wake ambiguous", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event", "waiting for a handled prompt");

	let handled = true;
	h.addInputHandler(() => {
		if (!handled) return undefined;
		handled = false;
		return { action: "handled" };
	});
	const consumed = await h.dispatchInput({ type: "input", source: "rpc", text: "handled" });
	assert.equal(consumed.action, "handled");

	await acceptedInput(h, "interactive");
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(observations(h).at(-1).wakeSource, "unknown");
});

test("overlapping input candidates cannot label an extension wake as user", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event", "waiting for overlapping prompts");

	// dispatchInput enters its input handler before awaiting the rest of the
	// preflight. Starting both operations without awaiting either creates two
	// candidates; the extension-origin prompt reaches acceptance after the
	// interactive candidate has entered, without a correlation key.
	const extensionPreflight = h.dispatchInput({ type: "input", source: "extension", text: "extension prompt" });
	const interactivePreflight = h.dispatchInput({ type: "input", source: "interactive", text: "interactive prompt" });
	await h.handlers.get("before_agent_start")({
		type: "before_agent_start",
		prompt: "extension prompt",
		systemPrompt: "",
		systemPromptOptions: {},
	}, h.ctx);
	assert.equal((await extensionPreflight).action, "continue");
	assert.equal((await interactivePreflight).action, "continue");

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(observations(h).at(-1).wakeSource, "unknown");
});

test("/goal status reports the waiting reason and identity", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "user", "waiting for approval");
	await h.commands.get("goal").handler("status", h.ctx);
	assert.match(h.notices.at(-1), /Waiting for: waiting for approval/);
	assert.match(h.notices.at(-1), /Wait id:/);
});

test("native wake ends the wait before provider work without adding a resume marker", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event");
	h.sent.length = 0;
	await acceptedInput(h, "interactive", "the event completed");
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(h.sent.length, 0);
	assert.equal(observations(h).filter((entry) => entry.kind === "wait_ended").length, 1);
});

test("yield settlement keeps native compaction ordering without a synthetic wake", options, async () => {
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

test("a compaction cancelled by another context owner settles without a failure warning", options, async () => {
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "event", "compact after handoff");
	await waitForSettlement(h);
	assert.equal(h.compactions.length, 1);
	h.notices.length = 0;
	h.compactions[0].onError(new Error("Compaction cancelled"));
	assert.deepEqual(h.notices, [], "another owner's cancellation is not a pi-goal failure");
	assert.equal(lastGoal(h).status, "yielded");

	const failing = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(failing);
	await createGoal(failing);
	await yieldGoal(failing, "event");
	await waitForSettlement(failing);
	failing.notices.length = 0;
	failing.compactions[0].onError(new Error("summarizer unavailable"));
	assert.equal(failing.notices.length, 1);
	assert.match(failing.notices[0], /Goal yield compaction failed/);
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
	assert.equal(lastGoal(h).waitId, undefined);
	assert.equal(observations(h).some((entry) => entry.wakeSource === "user" || entry.wakeSource === "event"), false);
});

test("a valid v4 yielded wait migrates and closes with the same identity", options, async () => {
	const legacy = {
		version: 4,
		id: "legacy-v4-wait",
		objective: "retain this objective",
		status: "yielded",
		tokenBudget: null,
		tokensUsed: 4,
		timeUsedSeconds: 5,
		createdAt: 1,
		updatedAt: 2,
		yieldReason: "old wait",
		yieldedAt: 2,
		waitId: "wait-v4",
		waitStartedAt: 2,
	};
	const h = makeHarness({ entries: [{ id: "legacy-v4", type: "custom", customType: "pi-goal", data: { goal: legacy } }] });
	await install(h, "startup");
	const ended = observations(h).find((entry) => entry.kind === "wait_ended");
	assert.ok(ended);
	assert.equal(ended.waitId, legacy.waitId);
	assert.equal(ended.waitStartedAt, legacy.waitStartedAt);
	assert.equal(ended.wakeSource, "unknown");
	assert.equal(ended.terminationReason, "session_restore");
	assert.equal(lastGoal(h).version, 5);
	assert.equal(lastGoal(h).status, "paused");
	assert.equal(lastGoal(h).waitId, undefined);
});

test("malformed v4 wait tuples fail safe through session start", options, async () => {
	const base = {
		version: 4,
		id: "invalid-v4",
		objective: "must stay stopped",
		status: "yielded",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		yieldReason: "old wait",
		yieldedAt: 1,
	};
	const invalidRecords = [
		{ ...base, waitId: "wait-v4", waitStartedAt: 1, waitTimeouts: "invalid" },
		{ ...base, waitId: "wait-v4", waitTimeouts: 3 },
		{ ...base, status: "active", waitStartedAt: 1, waitTimeouts: 3 },
	];
	for (const invalid of invalidRecords) {
		const h = makeHarness({ entries: [{ id: "invalid", type: "custom", customType: "pi-goal", data: { goal: invalid } }] });
		await install(h, "startup");
		assert.equal(lastGoal(h), invalid);
		assert.equal(observations(h).length, 0);
		assert.equal(h.sent.length, 0);
		assert.match(h.notices.at(-1), /Goal state ignored safely/);
		h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
		h.handlers.get("agent_end")({ messages: [] }, h.ctx);
		await Promise.resolve();
		assert.equal(lastGoal(h), invalid);
		assert.equal(h.sent.length, 0);
	}
});
