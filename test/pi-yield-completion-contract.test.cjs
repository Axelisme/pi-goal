const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function makeHarness({ entries = [], idle = false, pending = false } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const sent = [];
	const notices = [];
	let activeTools = ["create_goal"];
	let isIdle = idle;
	let hasPendingMessages = pending;
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) { sent.push({ message, options: sendOptions }); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
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
		isIdle: () => isIdle,
		hasPendingMessages: () => hasPendingMessages,
	};
	return {
		pi, ctx, handlers, tools, commands, sent, notices, entries,
		setIdle(value) { isIdle = value; },
		setPending(value) { hasPendingMessages = value; },
	};
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-yield-completion-contract.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	return jiti("../.pi/extensions/pi-goal/index.ts").default;
}

async function install(h, entriesReason = "startup") {
	loadExtension()(h.pi);
	await h.handlers.get("session_start")({ reason: entriesReason }, h.ctx);
}

async function createYielded(h, objective = "wait for the provider", reason = "provider completion") {
	await h.tools.get("create_goal").execute("create", { objective }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason, expect_wake_by: "event" }, null, null, h.ctx);
	h.sent.length = 0;
}

function lastGoal(h) {
	return h.entries.at(-1)?.data?.goal;
}

function flushMicrotasks() {
	return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

const goalTools = ["create_goal", "get_goal", "update_goal", "yield_goal"];
const stableGoalTools = ["host-tool", ...goalTools];

test("yield_goal exposes explicit wake intent and returns a quiet waiting contract", options, async () => {
	const h = makeHarness();
	await install(h);
	const tool = h.tools.get("yield_goal");
	assert.deepEqual(tool.parameters.required, ["reason", "expect_wake_by"]);
	assert.deepEqual(tool.parameters.properties.expect_wake_by.enum, ["user", "event"]);
	assert.equal(tool.parameters.properties.timeoutSeconds, undefined);

	await h.tools.get("create_goal").execute("create", { objective: "wait for approval" }, null, null, h.ctx);
	h.sent.length = 0;
	const result = await tool.execute("yield", { reason: "release owner approval", expect_wake_by: "user" }, null, null, h.ctx);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(result.terminate, true);
	assert.equal(payload.goal.expectWakeBy, "user");
	assert.equal(payload.waiting.id, payload.goal.waitId);
	assert.equal(payload.waiting.heartbeat, "waiting_without_heartbeat");
	assert.equal(payload.waiting.nextHeartbeatAt, null);
	assert.equal(payload.waiting.reasonCode, "user_away_prior");
	assert.equal(h.sent.length, 0);
});

test("goal tools stay stable while lifecycle validity is enforced at execution", options, async () => {
	const h = makeHarness();
	h.pi.setActiveTools(["host-tool"]);
	await install(h);

	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "an empty goal still exposes the complete Tool Interface");
	await assert.rejects(
		h.tools.get("yield_goal").execute("yield", { reason: "invalid without a goal" }, null, null, h.ctx),
		/yield_goal is only available for an active goal/,
	);
	const absentUpdate = await h.tools.get("update_goal").execute("update", { status: "complete" }, null, null, h.ctx);
	assert.equal(absentUpdate.isError, true);
	assert.match(absentUpdate.content[0].text, /No goal is set/);

	await h.tools.get("create_goal").execute("create", { objective: "keep schemas stable" }, null, null, h.ctx);
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "creating a goal must not change Tool schemas");
	await h.tools.get("yield_goal").execute("yield", { reason: "wait", expect_wake_by: "user" }, null, null, h.ctx);
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "yielding must not change Tool schemas");
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "resuming must not change Tool schemas");

	const completed = await h.tools.get("update_goal").execute("update", { status: "complete" }, null, null, h.ctx);
	assert.notEqual(completed.isError, true);
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "completion must not change Tool schemas");
	await assert.rejects(
		h.tools.get("yield_goal").execute("yield", { reason: "invalid after completion" }, null, null, h.ctx),
		/yield_goal is only available for an active goal/,
	);
	const completedAgain = await h.tools.get("update_goal").execute("update", { status: "complete" }, null, null, h.ctx);
	assert.equal(completedAgain.isError, true);
	assert.match(completedAgain.content[0].text, /must be active/);

	await h.tools.get("create_goal").execute("create", { objective: "reach the budget", tokenBudget: 1 }, null, null, h.ctx);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await h.handlers.get("turn_end")({ message: { usage: { totalTokens: 1 } } }, h.ctx);
	assert.equal(lastGoal(h).status, "budget_limited");
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "budget exhaustion must not change Tool schemas");
	await h.commands.get("goal").handler("clear", h.ctx);
	assert.equal(lastGoal(h), null);
	assert.deepEqual(h.pi.getActiveTools(), stableGoalTools, "clearing a goal must not change Tool schemas");
});

test("persisted yielded v2 restore pauses safely with its objective and reason, without continuation", options, async () => {
	const yielded = {
		version: 2,
		id: "yielded-restore",
		objective: "wait for an external approval",
		status: "yielded",
		tokenBudget: 500,
		tokensUsed: 17,
		timeUsedSeconds: 9,
		createdAt: 10,
		updatedAt: 20,
		yieldReason: "approval from the release owner",
		yieldedAt: 20,
	};
	const h = makeHarness({ entries: [{ type: "custom", customType: "pi-goal", data: { goal: yielded, statusBarEnabled: true } }] });
	await install(h, "reload");

	assert.deepEqual(lastGoal(h), { ...yielded, version: 4, status: "paused", updatedAt: lastGoal(h).updatedAt });
	assert.equal(lastGoal(h).objective, yielded.objective);
	assert.equal(lastGoal(h).yieldReason, yielded.yieldReason);
	assert.match(h.notices.at(-1), /Goal paused after reload\/restore/);
	assert.deepEqual(h.pi.getActiveTools(), goalTools);
	assert.equal(h.sent.length, 0, "restore must not publish or queue a continuation");
	assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0, "paused restore must remain continuation-free");

	await h.commands.get("goal").handler("status", h.ctx);
	assert.match(h.notices.at(-1), /Goal paused \(\/goal resume\)/);
	assert.match(h.notices.at(-1), /Objective: wait for an external approval/);
});

test("malformed and invalid yielded v2 records restore fail-safe without acquiring authority", options, async () => {
	const invalidRecords = [
		{
			version: 2,
			id: "missing-reason",
			objective: "must not resume",
			status: "yielded",
			tokenBudget: null,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
		{
			version: 2,
			id: "unknown-status",
			objective: "must not resume",
			status: "not-a-goal-status",
			tokenBudget: null,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
			yieldReason: "untrusted record",
		},
	];
	for (const invalid of invalidRecords) {
		const h = makeHarness({ entries: [{ type: "custom", customType: "pi-goal", data: { goal: invalid } }] });
		await install(h);

		assert.deepEqual(h.pi.getActiveTools(), goalTools);
		assert.equal(lastGoal(h), invalid, "invalid durable witness is not replaced by an autonomous state");
		assert.equal(h.sent.length, 0);
		assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
		h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
		assert.equal(lastGoal(h), invalid, "an unrelated turn cannot acquire authority from an invalid record");
		assert.match(h.notices.at(-1), /Goal state ignored safely/);
	}
});

test("registered goal commands transition a yielded goal with one matching publication and durable state", options, async () => {
	const cases = [
		{
			command: "resume",
			status: "active",
			kind: "resumed",
			assertGoal(goal) {
				assert.equal(goal.objective, "command transition objective");
				assert.equal(goal.yieldReason, "waiting for command", "resume retains the diagnostic reason for the resumed state");
			},
		},
		{
			command: "pause",
			status: "paused",
			kind: "paused",
			assertGoal(goal) {
				assert.equal(goal.objective, "command transition objective");
				assert.equal(goal.yieldReason, "waiting for command");
			},
		},
		{
			command: "clear",
			status: null,
			kind: "cleared",
			assertGoal(goal) {
				assert.equal(goal.objective, "command transition objective");
				assert.equal(goal.yieldReason, "waiting for command");
			},
		},
	];
	for (const item of cases) {
		const h = makeHarness();
		await install(h);
		await createYielded(h, "command transition objective", "waiting for command");
		await h.commands.get("goal").handler(item.command, h.ctx);

		assert.equal(h.sent.length, 1, `${item.command} publishes exactly one lifecycle event`);
		assert.equal(h.sent[0].message.details.kind, item.kind);
		assert.equal(h.sent[0].message.details.goal.status, item.status ?? "yielded");
		item.assertGoal(h.sent[0].message.details.goal);
		assert.deepEqual(h.pi.getActiveTools(), goalTools);
		assert.equal(lastGoal(h)?.status ?? null, item.status);
		if (item.command === "clear") assert.equal(lastGoal(h), null);
		h.setPending(true);
		assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
		await flushMicrotasks();
		assert.equal(h.sent.length, 1, `${item.command} does not add a continuation`);
	}
});

test("a later yielded run keeps its native custom wake entry across provider requests", options, async () => {
	const h = makeHarness();
	await install(h);
	await createYielded(h, "continue the audit", "waiting for the test provider");

	// Shipped Pi custom-message turns emit turn_start without before_agent_start. The native
	// custom input that starts the run is already persistent, so it is the sole wake marker.
	const { Agent } = await import(`${globalPi}/node_modules/@earendil-works/pi-agent-core/dist/index.js`);
	const { createAssistantMessageEventStream } = await import(`${globalPi}/node_modules/@earendil-works/pi-ai/dist/index.js`);
	const model = { id: "resume-contract", name: "resume-contract", api: "test", provider: "test", reasoning: false };
	const providerContexts = [];
	const providerGoalStatuses = [];
	let providerCalls = 0;
	const streamFn = (_model, context) => {
		providerCalls += 1;
		providerContexts.push(structuredClone(context.messages));
		providerGoalStatuses.push(lastGoal(h).status);
		const stream = createAssistantMessageEventStream();
		const toolUse = providerCalls === 1;
		const message = {
			role: "assistant",
			content: toolUse
				? [{ type: "toolCall", id: "inspect-goal", name: "get_goal", arguments: {} }]
				: [{ type: "text", text: "continue" }],
			api: "test", provider: "test", model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(),
		};
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
		return stream;
	};
	const agentTools = new Map([...h.tools.values()].map((definition) => [definition.name, {
		...definition,
		execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, h.ctx),
	}]));
	const agent = new Agent({
		initialState: { systemPrompt: "goal", model, thinkingLevel: "off", tools: [...agentTools.values()] },
		convertToLlm: (messages) => messages,
		streamFn,
	});
	agent.subscribe((event) => {
		if (event.type === "turn_start") h.handlers.get("turn_start")(event, h.ctx);
	});
	const persistentWake = {
		role: "custom",
		customType: "external-event",
		content: [{ type: "text", text: "The awaited external event completed." }],
		display: true,
		details: { kind: "terminal" },
		timestamp: Date.now(),
	};
	await agent.prompt(persistentWake);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(lastGoal(h).objective, "continue the audit");
	assert.equal(lastGoal(h).yieldReason, "waiting for the test provider");
	assert.deepEqual(providerGoalStatuses, ["active", "active"], "turn_start acquires authority before provider work");
	assert.equal(providerCalls, 2, "the fake provider makes two requests in one agent run");
	for (const messages of providerContexts) {
		const wakes = messages.filter((message) => message.role === "custom" && message.customType === "external-event");
		assert.equal(wakes.length, 1, "each provider request sees the one native wake entry");
		assert.deepEqual(wakes[0], persistentWake);
		assert.equal(messages.some((message) => message.customType === "pi-goal-event" && message.details?.resume === true), false);
	}
	assert.deepEqual(providerContexts[0][0], persistentWake);
	assert.deepEqual(providerContexts[1][0], persistentWake, "the later request keeps the native wake in its prior prefix");

	h.handlers.get("agent_end")({}, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 1, "one plugin continuation is published, not one per lifecycle callback");
	assert.equal(h.sent[0].message.details.kind, "continuation");
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(h.sent[0].options.triggerTurn, true);
});

test("a yielded resume with a pending same-run message adds no duplicate continuation", options, async () => {
	const h = makeHarness({ pending: true });
	await install(h);
	await createYielded(h, "resume the same run", "waiting for a pending event");

	h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	h.handlers.get("agent_end")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0, "pending public Pi messages suppress plugin continuation");
	assert.equal(lastGoal(h).status, "active");
});

test("an aborted agent run pauses an active goal without queuing another continuation", options, async () => {
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "stop when interrupted" }, null, null, h.ctx);
	h.sent.length = 0;

	h.handlers.get("agent_end")({ messages: [
		{ role: "assistant", content: [], stopReason: "aborted" },
	] }, h.ctx);
	await flushMicrotasks();

	assert.equal(lastGoal(h).status, "paused");
	assert.deepEqual(h.pi.getActiveTools(), goalTools);
	assert.equal(h.sent.length, 0, "an interruption must not publish or queue a wake-up message");
	assert.match(h.notices.at(-1), /Goal paused after interruption/);
});

test("an active goal queues only when agent_end has no pending public message", options, async () => {
	const h = makeHarness({ pending: true });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "pending gate" }, null, null, h.ctx);
	h.sent.length = 0;

	h.handlers.get("agent_end")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0);
	h.setPending(false);
	h.handlers.get("agent_end")({}, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.details.kind, "continuation");
});
