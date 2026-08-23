const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function makeHarness({ runtimeSupport = false, contextTokens } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const sent = [];
	const notices = [];
	const compactions = [];
	let activeTools = ["create_goal"];
	let appendThrows = false;
	let sendThrows = false;
	let compactThrows = false;
	let pendingMessages = false;
	let idle = true;
	let tokens = contextTokens;
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) {
			if (sendThrows) throw new Error("runtime inactive");
			sent.push({ message, options: sendOptions });
		},
		appendEntry(customType, data) {
			if (appendThrows) throw new Error("durability unavailable");
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() { return activeTools; },
		setActiveTools(next) { activeTools = next; },
	};
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		ui: {
			setStatus() {},
			notify(message) { notices.push(String(message)); },
			confirm: async () => true,
		},
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
	};
	if (runtimeSupport) {
		ctx.getContextUsage = () => tokens === undefined ? undefined : { tokens, contextWindow: 200_000, percent: tokens == null ? null : tokens / 2_000 };
		ctx.compact = (callbacks) => {
			compactions.push(callbacks);
			if (compactThrows) throw new Error("compaction request failed");
		};
	}
	return {
		pi, ctx, handlers, tools, commands, entries, sent, notices, compactions,
		setAppendThrows(value) { appendThrows = value; },
		setSendThrows(value) { sendThrows = value; },
		setCompactThrows(value) { compactThrows = value; },
		setPending(value) { pendingMessages = value; },
		setIdle(value) { idle = value; },
		setContextTokens(value) { tokens = value; },
	};
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-yield-timeout.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	return jiti("../.pi/extensions/pi-goal/index.ts").default;
}

async function install(h) {
	loadExtension()(h.pi);
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
}

function lastGoal(h) {
	return h.entries.at(-1)?.data?.goal;
}

test("yield_goal exposes a 30–600 second timeout range", options, async () => {
	const h = makeHarness();
	await install(h);
	const timeoutSchema = h.tools.get("yield_goal").parameters.properties.timeoutSeconds;
	assert.equal(timeoutSchema.minimum, 30);
	assert.equal(timeoutSchema.maximum, 600);
});

test("yield_goal accepts a bounded custom timeout", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "check promptly" }, null, null, h.ctx);
	h.sent.length = 0;

	const result = await h.tools.get("yield_goal").execute("yield", { reason: "waiting briefly", timeoutSeconds: 30 }, null, null, h.ctx);
	assert.equal(JSON.parse(result.content[0].text).timeoutSeconds, 30);
	t.mock.timers.tick(29_999);
	assert.equal(h.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sent[0].message.details.kind, "yield_timeout");
});

test("timeout context threshold preserves immediate fallback at or below the boundary and when usage is unknown", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cases = [
		{ name: "below", runtimeSupport: true, contextTokens: 99_999 },
		{ name: "equal", runtimeSupport: true, contextTokens: 100_000 },
		{ name: "null", runtimeSupport: true, contextTokens: null },
		{ name: "absent", runtimeSupport: true, contextTokens: undefined },
		{ name: "unsupported", runtimeSupport: false },
	];
	for (const current of cases) {
		const h = makeHarness(current);
		await install(h);
		await h.tools.get("create_goal").execute("create", { objective: `fallback ${current.name}` }, null, null, h.ctx);
		await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
		h.sent.length = 0;

		t.mock.timers.tick(30_000);
		assert.equal(h.compactions.length, 0, current.name);
		assert.equal(h.sent.length, 1, current.name);
		assert.equal(h.sent[0].message.details.kind, "yield_timeout", current.name);
	}
});

test("large timeout context compacts once before the existing follow-up", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 100_001 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "compact before reassessing" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	t.mock.timers.tick(30_000);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 0, "completion owns delivery ordering");
	h.compactions[0].onComplete({});
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.details.kind, "yield_timeout");
	assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	h.compactions[0].onComplete({});
	assert.equal(h.sent.length, 1, "a repeated callback cannot redeliver");
});

test("a busy supported runtime defers threshold evaluation until agent_settled", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "wait until fully settled" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;
	h.setIdle(false);

	t.mock.timers.tick(30_000);
	assert.equal(h.compactions.length, 0);
	assert.equal(h.sent.length, 0);
	h.setIdle(true);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 0);
	h.compactions[0].onComplete({});
	assert.equal(h.sent.length, 1);
});

test("input observed before a queued compaction callback suppresses timeout delivery", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "native input wins" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	t.mock.timers.tick(30_000);
	assert.equal(h.compactions.length, 1);
	await h.handlers.get("input")({ type: "input", text: "native completion", source: "interactive" }, h.ctx);
	h.compactions[0].onComplete({});
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 0);
});

test("native and lifecycle changes suppress stale compaction callbacks", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cases = [
		{
			name: "pending message",
			change: async (h) => h.setPending(true),
		},
		{
			name: "native turn",
			change: async (h) => h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx),
		},
		{
			name: "pause",
			change: async (h) => h.commands.get("goal").handler("pause", h.ctx),
		},
		{
			name: "replacement",
			change: async (h) => h.commands.get("goal").handler("replacement objective", h.ctx),
		},
		{
			name: "budget limiting",
			budget: 1,
			startTurn: true,
			change: async (h) => h.handlers.get("turn_end")({ message: { usage: { totalTokens: 1 } } }, h.ctx),
		},
		{
			name: "shutdown",
			change: async (h) => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx),
		},
	];

	for (const current of cases) {
		const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
		await install(h);
		await h.tools.get("create_goal").execute("create", { objective: current.name, tokenBudget: current.budget }, null, null, h.ctx);
		if (current.startTurn) await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
		await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
		h.sent.length = 0;
		t.mock.timers.tick(30_000);
		assert.equal(h.compactions.length, 1, current.name);

		await current.change(h);
		h.compactions[0].onComplete({});
		h.compactions[0].onError(new Error("late failure"));
		assert.equal(h.sent.filter((entry) => entry.message.details.kind === "yield_timeout").length, 0, current.name);
		assert.equal(h.notices.some((notice) => notice.includes("late failure")), false, current.name);
	}
});

test("a rearmed timeout identity ignores the prior compaction callback", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "same goal, new yield" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "first wait", timeoutSeconds: 30 }, null, null, h.ctx);
	t.mock.timers.tick(30_000);
	const firstCompaction = h.compactions[0];

	await h.commands.get("goal").handler("resume", h.ctx);
	h.sent.length = 0;
	await h.tools.get("yield_goal").execute("yield", { reason: "second wait", timeoutSeconds: 30 }, null, null, h.ctx);
	t.mock.timers.tick(30_000);
	assert.equal(h.compactions.length, 2);
	firstCompaction.onComplete({});
	assert.equal(h.sent.length, 0);
	h.compactions[1].onComplete({});
	assert.equal(h.sent.filter((entry) => entry.message.details.kind === "yield_timeout").length, 1);
});

test("compaction completion deferred by a busy runtime enters delivery-only settlement", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "never compact twice" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;
	t.mock.timers.tick(30_000);

	h.setIdle(false);
	h.compactions[0].onComplete({});
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 0);
	h.setIdle(true);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.sent.length, 1);
});

test("compaction callback and synchronous failures warn and fall back exactly once", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const callbackFailure = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(callbackFailure);
	await callbackFailure.tools.get("create_goal").execute("create", { objective: "callback fallback" }, null, null, callbackFailure.ctx);
	await callbackFailure.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, callbackFailure.ctx);
	callbackFailure.sent.length = 0;
	t.mock.timers.tick(30_000);
	callbackFailure.setIdle(false);
	callbackFailure.compactions[0].onError(new Error("summary failed"));
	assert.match(callbackFailure.notices.at(-1), /compaction failed: Error: summary failed/);
	assert.equal(callbackFailure.compactions.length, 1);
	assert.equal(callbackFailure.sent.length, 0);
	callbackFailure.setIdle(true);
	await callbackFailure.handlers.get("agent_settled")({ type: "agent_settled" }, callbackFailure.ctx);
	assert.equal(callbackFailure.compactions.length, 1);
	assert.equal(callbackFailure.sent.length, 1);
	callbackFailure.compactions[0].onError(new Error("duplicate"));
	assert.equal(callbackFailure.sent.length, 1);

	const synchronousFailure = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(synchronousFailure);
	await synchronousFailure.tools.get("create_goal").execute("create", { objective: "synchronous fallback" }, null, null, synchronousFailure.ctx);
	await synchronousFailure.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, synchronousFailure.ctx);
	synchronousFailure.sent.length = 0;
	synchronousFailure.setCompactThrows(true);
	t.mock.timers.tick(30_000);
	assert.match(synchronousFailure.notices.at(-1), /compaction failed: Error: compaction request failed/);
	assert.equal(synchronousFailure.compactions.length, 1);
	assert.equal(synchronousFailure.sent.length, 1);
});

test("an invalid timeout leaves the active goal unchanged", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "keep working" }, null, null, h.ctx);
	h.sent.length = 0;

	await assert.rejects(
		h.tools.get("yield_goal").execute("yield", { reason: "bad timeout", timeoutSeconds: 601 }, null, null, h.ctx),
		/timeoutSeconds must be an integer between 30 and 600 seconds/,
	);
	assert.equal(lastGoal(h).status, "active");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
});

test("a queued native message at the deadline suppresses the fallback wake-up", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "prefer native input" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting for completion", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	h.setPending(true);
	t.mock.timers.tick(30_000);
	assert.equal(h.sent.length, 0);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
});

test("a native turn before the deadline cancels the fallback wake-up", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "resume natively" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting for completion", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
});

test("pause and session shutdown cancel a pending fallback wake-up", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "stay stopped" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	await h.commands.get("goal").handler("pause", h.ctx);
	h.sent.length = 0;
	await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
	assert.equal(lastGoal(h).status, "paused");
});

test("reload clears the fallback and converts the yielded goal to paused", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "pause on reload" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting across reload", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
	assert.equal(lastGoal(h).status, "paused");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
});

test("replacing a yielded goal prevents its stale fallback from waking the replacement", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "old objective" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "old prerequisite", timeoutSeconds: 30 }, null, null, h.ctx);
	await h.commands.get("goal").handler("replacement objective", h.ctx);
	h.sent.length = 0;

	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
	assert.equal(lastGoal(h).objective, "replacement objective");
	assert.equal(lastGoal(h).status, "active");
});

test("a timeout delivery failure leaves the goal yielded and reports a warning", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "fail delivery safely" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;
	h.setSendThrows(true);

	t.mock.timers.tick(30_000);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0);
	assert.match(h.notices.at(-1), /could not start a fallback turn/);
});

test("a nondurable yield remains terminal without arming autonomous fallback", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "fail closed" }, null, null, h.ctx);
	h.sent.length = 0;
	h.setAppendThrows(true);

	const result = await h.tools.get("yield_goal").execute("yield", { reason: "durability unavailable", timeoutSeconds: 30 }, null, null, h.ctx);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.persisted, false);
	assert.equal(payload.timeoutAt, null);
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
});

test("yield_goal stays terminal, then its default timeout wakes the same yielded goal once", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "finish safely" }, null, null, h.ctx);
	h.sent.length = 0;

	const result = await h.tools.get("yield_goal").execute("yield", { reason: "waiting for a child" }, null, null, h.ctx);
	assert.equal(result.terminate, true);
	assert.equal(JSON.parse(result.content[0].text).timeoutSeconds, 300);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0, "yield itself must not manufacture a wake-up");

	t.mock.timers.tick(299_999);
	assert.equal(h.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.details.kind, "yield_timeout");
	assert.equal(h.sent[0].options.triggerTurn, true);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(lastGoal(h).status, "yielded", "turn_start remains the authority acquisition seam");

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 1, "the timeout is one-shot");
});
