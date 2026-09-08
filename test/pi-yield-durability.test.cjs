const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function lastGoal(entries) {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].customType === "pi-goal") return entries[i].data?.goal;
	}
	return undefined;
}

function harness() {
	const handlers = new Map();
	const tools = new Map();
	const entries = [];
	const notices = [];
	const sent = [];
	let appendThrows = false;
	let activeTools = ["create_goal"];
	let onTools;
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message) => { sent.push(message); },
		appendEntry: (customType, data) => {
			if (appendThrows) throw new Error("durability unavailable");
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => activeTools,
		setActiveTools: (next) => { activeTools = next; onTools?.(next); },
	};
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		ui: { setStatus: () => {}, notify: (message) => notices.push(String(message)) },
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
	return {
		pi, ctx, handlers, tools, entries, notices, sent,
		failAppend: () => { appendThrows = true; },
		attach: (agent, byName) => { onTools = (names) => { agent.state.tools = names.map((name) => byName.get(name)).filter(Boolean); }; },
	};
}

test("failed yield persistence remains terminal and does not start another provider turn", options, async () => {
	const jiti = createJiti(resolve(__dirname, "pi-yield-durability.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	const { default: extension } = jiti("../.pi/extensions/pi-goal/index.ts");
	const { Agent } = await import(`${globalPi}/node_modules/@earendil-works/pi-agent-core/dist/index.js`);
	const { createAssistantMessageEventStream } = await import(`${globalPi}/node_modules/@earendil-works/pi-ai/dist/index.js`);
	const h = harness();
	extension(h.pi);
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.tools.get("create_goal").execute("create", { objective: "wait durably" }, null, null, h.ctx);
	h.sent.length = 0;
	const model = { id: "yield-durability", name: "yield-durability", api: "test", provider: "test", reasoning: false };
	const byName = new Map([...h.tools.values()].map((definition) => [definition.name, {
		...definition,
		execute: (id, params, signal, onUpdate) => definition.execute(id, params, signal, onUpdate, h.ctx),
	}]));
	let providerCalls = 0;
	const streamFn = () => {
		providerCalls += 1;
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "yield-call", name: "yield_goal", arguments: { reason: "provider completion", expect_wake_by: "event" } }],
			api: "test", provider: "test", model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse", timestamp: Date.now(),
		};
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "toolUse", message }); });
		return stream;
	};
	const agent = new Agent({ initialState: { systemPrompt: "goal", model, thinkingLevel: "off", tools: [...byName.values()] }, convertToLlm: (messages) => messages, streamFn });
	h.attach(agent, byName);
	h.failAppend();
	await agent.prompt("external prerequisite");
	assert.equal(providerCalls, 1);
	assert.equal(h.sent.length, 0, "failed yield must not publish or queue a marker");
	assert.equal(lastGoal(h.entries).status, "active", "durable witness remains unchanged");
	assert.equal(JSON.stringify(agent.state.messages).includes('"persisted":false'), true, "terminal result exposes nondurable evidence");
	// The owner has failed closed in memory; agent_end cannot queue continuation.
	assert.equal(h.handlers.get("agent_end")({}, h.ctx), undefined);
});
