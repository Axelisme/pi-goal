const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const available = existsSync(globalPi);

function makeHarness() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const sent = [];
	const entries = [];
	let activeTools = ["create_goal"];
	let onSetActiveTools;
	let appendThrows = false;
	const notices = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, options) { sent.push({ message, options }); },
		appendEntry(customType, data) {
			if (appendThrows) throw new Error("durability unavailable");
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() { return activeTools; },
		setActiveTools(next) {
			activeTools = next;
			onSetActiveTools?.(next);
		},
	};
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		ui: {
			setStatus() {},
			notify(message) { notices.push(message); },
			confirm: async () => true,
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
	return {
		handlers, tools, commands, sent, entries, notices, pi, ctx,
		setAppendThrows: (value) => { appendThrows = value; },
		attachAgent: (agent, namesToTools) => { onSetActiveTools = (names) => { agent.state.tools = names.map((name) => namesToTools.get(name)).filter(Boolean); }; },
	};
}

const testOptions = available ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function lastGoal(h) {
	for (let i = h.entries.length - 1; i >= 0; i--) {
		if (h.entries[i].customType === "pi-goal") return h.entries[i].data?.goal;
	}
	return undefined;
}

test("Pi message_end filters sibling tools before execution and yield terminates without self-publication", testOptions, async () => {
	const jiti = createJiti(resolve(__dirname, "pi-seam-behavior.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	const { default: extension } = jiti("../.pi/extensions/pi-goal/index.ts");
	const h = makeHarness();
	extension(h.pi);
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.tools.get("create_goal").execute("create", { objective: "wait for evidence" }, null, null, h.ctx);
	h.sent.length = 0;

	const replaced = h.handlers.get("message_end")({ message: {
		role: "assistant",
		content: [
			{ type: "text", text: "handoff" },
			{ type: "toolCall", name: "write_file", id: "side" },
			{ type: "toolCall", name: "yield_goal", id: "yield" },
		],
	} }, h.ctx);
	assert.equal(replaced.message.content.filter((part) => part.type === "toolCall").length, 1);
	assert.equal(replaced.message.content.find((part) => part.type === "toolCall").name, "yield_goal");

	const { Agent } = await import(`${globalPi}/node_modules/@earendil-works/pi-agent-core/dist/index.js`);
	const { createAssistantMessageEventStream } = await import(`${globalPi}/node_modules/@earendil-works/pi-ai/dist/index.js`);
	const model = { id: "snapshot-test", name: "snapshot-test", api: "test", provider: "test", reasoning: false };
	const providerTools = [];
	const streamFn = (_model, context) => {
		providerTools.push((context.tools ?? []).map((tool) => tool.name));
		const stream = createAssistantMessageEventStream();
		const message = { role: "assistant", content: [{ type: "text", text: "waiting" }], api: "test", provider: "test", model: "snapshot-test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); });
		return stream;
	};
	const agentTools = new Map([...h.tools.values()].map((definition) => [definition.name, { ...definition, execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, h.ctx) }]));
	const agent = new Agent({ initialState: { systemPrompt: "goal prompt", model, thinkingLevel: "off", tools: [...agentTools.values()] }, convertToLlm: (messages) => messages, streamFn });
	h.attachAgent(agent, agentTools);
	const result = await h.tools.get("yield_goal").execute("yield", { reason: "waiting for provider", expect_wake_by: "event" }, null, null, h.ctx);
	assert.equal(result.terminate, true);
	assert.equal(result.isTerminal, undefined);
	assert.equal(h.sent.length, 0, "yield must not queue its own marker while streaming");
	assert.equal(lastGoal(h).status, "yielded");
	await h.commands.get("goal").handler("status", h.ctx);
	assert.match(h.notices.at(-1), /Goal yielded: waiting for provider/);
	assert.match(h.notices.at(-1), /Waiting for: waiting for provider/);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await agent.prompt("external event");
	assert.deepEqual(providerTools.at(-1).filter((name) => ["get_goal", "update_goal", "yield_goal"].includes(name)).sort(), ["get_goal", "update_goal", "yield_goal"]);
	assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
});

test("reload pauses active goals and failed resume persistence remains yielded", testOptions, async () => {
	const jiti = createJiti(resolve(__dirname, "pi-seam-behavior.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	const { default: extension } = jiti("../.pi/extensions/pi-goal/index.ts");
	const h = makeHarness();
	extension(h.pi);
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.tools.get("create_goal").execute("create", { objective: "preserve reload safety" }, null, null, h.ctx);
	await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
	assert.equal(lastGoal(h).status, "paused");
	await h.tools.get("create_goal").execute("create", { objective: "reload failure safety" }, null, null, h.ctx);
	h.setAppendThrows(true);
	await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
	assert.equal(h.notices.some((notice) => String(notice).includes("revoked autonomy in memory")), true);
	assert.equal(h.pi.getActiveTools().includes("yield_goal"), true, "revocation keeps the Tool Interface stable");
	h.setAppendThrows(false);

	await h.tools.get("create_goal").execute("create", { objective: "account safely" }, null, null, h.ctx);
	h.setAppendThrows(true);
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	await h.handlers.get("turn_end")({ message: { usage: { totalTokens: 1 } } }, h.ctx);
	assert.equal(lastGoal(h).status, "active", "durable witness remains the prior active record");
	assert.equal(h.pi.getActiveTools().includes("yield_goal"), true, "failed retention keeps Tool schemas stable");
	const retainedResult = await h.tools.get("get_goal").execute("get", {}, null, null, h.ctx);
	assert.equal(JSON.parse(retainedResult.content[0].text).goal.status, "paused");
	assert.equal(JSON.parse(retainedResult.content[0].text).goal.tokensUsed, 1);
	assert.equal(h.notices.some((notice) => String(notice).includes("stopped authority in memory")), true);
	assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
	h.setAppendThrows(false);

	await h.tools.get("yield_goal").execute("yield", { reason: "external event", expect_wake_by: "event" }, null, null, h.ctx).catch(() => {});
	// The paused goal cannot yield; establish a yielded record through a fresh goal.
	await h.tools.get("create_goal").execute("create", { objective: "resume transaction" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "external event", expect_wake_by: "event" }, null, null, h.ctx);
	h.setAppendThrows(true);
	h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "yielded", "failed resume keeps the durable witness yielded");
	assert.equal(h.notices.some((notice) => String(notice).includes("resume remained yielded")), true);
	h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
});
