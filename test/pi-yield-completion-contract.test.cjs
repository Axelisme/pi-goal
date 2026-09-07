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
	await h.tools.get("yield_goal").execute("yield", { reason }, null, null, h.ctx);
	h.sent.length = 0;
}

function lastGoal(h) {
	return h.entries.at(-1)?.data?.goal;
}

function flushMicrotasks() {
	return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

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

	assert.deepEqual(lastGoal(h), { ...yielded, version: 3, status: "paused", updatedAt: lastGoal(h).updatedAt });
	assert.equal(lastGoal(h).objective, yielded.objective);
	assert.equal(lastGoal(h).yieldReason, yielded.yieldReason);
	assert.match(h.notices.at(-1), /Goal paused after reload\/restore/);
	assert.deepEqual(h.pi.getActiveTools(), ["create_goal"]);
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

		assert.deepEqual(h.pi.getActiveTools(), ["create_goal"]);
		assert.equal(lastGoal(h), invalid, "invalid durable witness is not replaced by an autonomous state");
		assert.equal(h.sent.length, 0);
		assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
		const beforeStart = h.handlers.get("before_agent_start")({ prompt: "unrelated" }, h.ctx);
		assert.equal(beforeStart, undefined);
		assert.match(h.notices.at(-1), /Goal state ignored safely/);
	}
});

test("registered goal commands transition a yielded goal with one matching publication and durable state", options, async () => {
	const cases = [
		{
			command: "resume",
			status: "active",
			kind: "resumed",
			tools: ["create_goal", "get_goal", "update_goal", "yield_goal"],
			assertGoal(goal) {
				assert.equal(goal.objective, "command transition objective");
				assert.equal(goal.yieldReason, "waiting for command", "resume retains the diagnostic reason for the resumed state");
			},
		},
		{
			command: "pause",
			status: "paused",
			kind: "paused",
			tools: ["create_goal"],
			assertGoal(goal) {
				assert.equal(goal.objective, "command transition objective");
				assert.equal(goal.yieldReason, "waiting for command");
			},
		},
		{
			command: "clear",
			status: null,
			kind: "cleared",
			tools: ["create_goal"],
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
		assert.deepEqual(h.pi.getActiveTools(), item.tools);
		assert.equal(lastGoal(h)?.status ?? null, item.status);
		if (item.command === "clear") assert.equal(lastGoal(h), null);
		h.setPending(true);
		assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
		await flushMicrotasks();
		assert.equal(h.sent.length, 1, `${item.command} does not add a continuation`);
	}
});

test("a later yielded run injects one persistent resume marker and queues one continuation", options, async () => {
	const h = makeHarness();
	await install(h);
	await createYielded(h, "continue the audit", "waiting for the test provider");

	const injected = h.handlers.get("before_agent_start")({ prompt: "external event" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(lastGoal(h).objective, "continue the audit");
	assert.equal(lastGoal(h).yieldReason, "waiting for the test provider");
	assert.equal(injected.message.customType, "pi-goal-event");
	assert.equal(injected.message.details.kind, "resumed");
	assert.equal(injected.message.details.resume, true);
	assert.match(injected.message.content, /waiting for the test provider/);
	assert.equal(injected.message.details.goal.objective, "continue the audit");

	const priorMessages = [{ role: "user", content: [{ type: "text", text: "external event" }] }];
	const persistentMarker = { role: "custom", ...injected.message };
	const firstProviderMessages = [...priorMessages, persistentMarker];
	const laterProviderMessages = [
		...firstProviderMessages,
		{ role: "assistant", content: [{ type: "text", text: "unrelated assistant response" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool result" }] },
	];
	assert.deepEqual(laterProviderMessages.slice(0, firstProviderMessages.length), firstProviderMessages);
	assert.equal(h.handlers.get("before_agent_start")({ prompt: "already active" }, h.ctx), undefined, "one wake injects exactly one marker");

	h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 1, "one plugin continuation is published, not one per lifecycle callback");
	assert.equal(h.sent[0].message.details.kind, "continuation");
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(h.sent[0].options.triggerTurn, true);
});

test("a yielded resume with a pending same-run message injects one marker and no duplicate continuation", options, async () => {
	const h = makeHarness({ pending: true });
	await install(h);
	await createYielded(h, "resume the same run", "waiting for a pending event");

	const resumed = h.handlers.get("before_agent_start")({ prompt: "pending event" }, h.ctx);
	assert.equal(resumed.message.details.resume, true);
	assert.equal(h.handlers.get("before_agent_start")({ prompt: "already active" }, h.ctx), undefined);

	h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
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
	assert.deepEqual(h.pi.getActiveTools(), ["create_goal"]);
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
