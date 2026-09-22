const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };

function makeHarness({ idle = false, pending = false } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const sent = [];
	const entries = [];
	const notices = [];
	let activeTools = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) { sent.push({ message, options: sendOptions }); },
		appendEntry(customType, data) { entries.push({ id: `e${entries.length + 1}`, parentId: entries.at(-1)?.id ?? null, type: "custom", customType, data }); },
		getActiveTools() { return activeTools; },
		setActiveTools(next) { activeTools = next; },
	};
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null },
		ui: { setStatus() {}, notify(message) { notices.push(String(message)); }, confirm: async () => true },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};
	return { handlers, tools, commands, sent, entries, notices, pi, ctx };
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-self-wake.test.cjs"), {
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

async function createGoal(h, objective = "finish the migration") {
	await h.tools.get("create_goal").execute("create", { objective }, null, null, h.ctx);
}

async function yieldGoal(h, reason = "waiting for the reviewer") {
	await h.tools.get("yield_goal").execute("yield", { reason }, null, null, h.ctx);
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

function flushMicrotasks() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function goalEventMessage(kind) {
	return { role: "custom", customType: "pi-goal-event", content: [{ type: "text", text: kind }], details: { kind } };
}

test("a continuation queued before the yield cannot wake the wait it is delivered after", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h, "waiting for the deploy to finish");
	const waitId = lastGoal(h).waitId;
	h.sent.length = 0;

	// Pi holds an undelivered follow-up across turns and drains it once the tool loop
	// stops, which is exactly the turn that follows a terminal yield.
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await h.handlers.get("message_end")({ type: "message_end", message: goalEventMessage("continuation") }, h.ctx);

	assert.equal(lastGoal(h).status, "yielded", "a goal cannot wake itself with its own queued continuation");
	assert.equal(lastGoal(h).waitId, waitId, "the wait keeps its identity");
	assert.equal(observations(h).filter((entry) => entry.kind === "wait_ended").length, 0);

	h.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0, "a yielded goal publishes no further continuation");
});

test("a delivered timeout follow-up ends the wait as a timeout, not as an external wake", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h);
	const waitId = lastGoal(h).waitId;

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await h.handlers.get("message_end")({ type: "message_end", message: goalEventMessage("timeout") }, h.ctx);

	assert.equal(lastGoal(h).status, "active");
	const ended = observations(h).filter((entry) => entry.kind === "wait_ended" && entry.waitId === waitId);
	assert.equal(ended.length, 1);
	assert.equal(ended[0].terminationReason, "timeout");
});

test("a foreign message still wakes the wait on the turn that carries it", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h);
	const waitId = lastGoal(h).waitId;

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await h.handlers.get("message_end")({
		type: "message_end",
		message: { role: "custom", customType: "subagent-notify", content: [{ type: "text", text: "the subagent finished" }] },
	}, h.ctx);

	assert.equal(lastGoal(h).status, "active");
	const ended = observations(h).filter((entry) => entry.kind === "wait_ended" && entry.waitId === waitId);
	assert.equal(ended.length, 1);
	assert.equal(ended[0].terminationReason, "native_wake");
});

test("a run that ends on a provider error queues no continuation for Pi to orphan", options, async () => {
	const errored = makeHarness();
	await install(errored);
	await createGoal(errored);
	errored.sent.length = 0;

	errored.handlers.get("agent_end")({ messages: [
		{ role: "toolResult", toolName: "bash" },
		{ role: "assistant", stopReason: "error", errorMessage: "WebSocket error" },
	] }, errored.ctx);
	await flushMicrotasks();

	assert.equal(errored.sent.length, 0, "Pi retries the errored run itself and never drains this continuation");
	assert.equal(lastGoal(errored).status, "active", "accounting and authority survive the provider error");
	assert.match(errored.notices.at(-1), /Goal continuation held after a provider error/);

	const completed = makeHarness();
	await install(completed);
	await createGoal(completed);
	completed.sent.length = 0;

	completed.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] }, completed.ctx);
	await flushMicrotasks();

	assert.equal(completed.sent.length, 1, "an ordinary run still continues the goal");
	assert.equal(completed.sent[0].message.details.kind, "continuation");
});

test("Pi draining a stale continuation after a terminal yield leaves the goal yielded", options, async () => {
	const h = makeHarness();
	await install(h);
	await createGoal(h, "keep working until the reviewer answers");

	const { Agent } = await import(`${globalPi}/node_modules/@earendil-works/pi-agent-core/dist/index.js`);
	const { createAssistantMessageEventStream } = await import(`${globalPi}/node_modules/@earendil-works/pi-ai/dist/index.js`);
	const model = { id: "self-wake", name: "self-wake", api: "test", provider: "test", reasoning: false };
	const goalStatusPerRequest = [];
	let providerCalls = 0;
	const streamFn = () => {
		providerCalls += 1;
		goalStatusPerRequest.push(lastGoal(h).status);
		const stream = createAssistantMessageEventStream();
		const yielding = providerCalls === 1;
		const message = {
			role: "assistant",
			content: yielding
				? [{ type: "toolCall", id: "hand-off", name: "yield_goal", arguments: { reason: "waiting for the reviewer" } }]
				: [{ type: "text", text: "still waiting" }],
			api: "test", provider: "test", model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: yielding ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
		return stream;
	};
	const agentTools = [...h.tools.values()].map((definition) => ({
		...definition,
		execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, h.ctx),
	}));
	const agent = new Agent({
		initialState: { systemPrompt: "goal", model, thinkingLevel: "off", tools: agentTools },
		convertToLlm: (messages) => messages,
		streamFn,
	});
	agent.subscribe((event) => {
		const handler = h.handlers.get(event.type);
		if (handler) handler(event, h.ctx);
	});

	// An earlier provider error left this continuation in Pi's follow-up queue. Pi
	// drains it once the tool loop stops, which the terminal yield does.
	agent.followUp(goalEventMessage("continuation"));
	await agent.prompt("start working");

	assert.equal(providerCalls, 2, "Pi delivers the stale follow-up in a second turn of the same run");
	assert.deepEqual(goalStatusPerRequest, ["active", "yielded"], "the yield survives Pi's own queued message");
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(observations(h).filter((entry) => entry.kind === "wait_ended").length, 0);
});
