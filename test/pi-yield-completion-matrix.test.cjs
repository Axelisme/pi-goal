const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function makeHarness({ entries = [], sessionId = "session-current", sessionFile } = {}) {
	const handlers = new Map();
	const eventHandlers = new Map();
	const tools = new Map();
	const sent = [];
	let activeTools = ["create_goal"];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		events: {
			on(name, handler) {
				const listeners = eventHandlers.get(name) ?? new Set();
				listeners.add(handler);
				eventHandlers.set(name, listeners);
				return () => listeners.delete(handler);
			},
			emit(name, data) {
				for (const handler of eventHandlers.get(name) ?? []) handler(data);
			},
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) { sent.push({ message, options: sendOptions }); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
		getActiveTools() { return activeTools; },
		setActiveTools(next) { activeTools = next; },
	};
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		ui: { setStatus() {}, notify() {}, confirm: async () => true },
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
	return { pi, ctx, handlers, tools, sent, entries };
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-yield-completion-matrix.test.cjs"), {
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

async function createYielded(h) {
	await h.tools.get("create_goal").execute("create", { objective: "wait for the provider" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "provider completion" }, null, null, h.ctx);
	h.sent.length = 0;
}

function lastGoal(h) {
	return h.entries.at(-1)?.data?.goal;
}

function shutdownAfter(t, ...harnesses) {
	t.after(() => {
		for (const h of harnesses) h.handlers.get("session_shutdown")();
	});
}

test("persisted sessions use the completion protocol's session-file identity", options, async (t) => {
	const h = makeHarness({ sessionFile: "/tmp/current-session.jsonl" });
	await install(h);
	shutdownAfter(t, h);
	await createYielded(h);

	h.pi.events.emit("subagent:async-complete", { sessionId: "session-current", success: true, exitCode: 0 });
	assert.equal(h.sent.length, 0, "the fallback UUID must not match when a session file owns identity");
	h.pi.events.emit("subagent:async-complete", { sessionId: "/tmp/current-session.jsonl", success: true, exitCode: 0 });
	assert.equal(h.sent.length, 1);
});

test("subagent completion wake ignores malformed, cross-session, and non-success payloads", options, async (t) => {
	const h = makeHarness();
	await install(h);
	shutdownAfter(t, h);
	await createYielded(h);
	const yielded = lastGoal(h);
	const ignored = [
		null,
		[],
		{},
		{ sessionId: "" },
		{ sessionId: " session-current ", success: true, exitCode: 0 },
		{ sessionId: "another-session", success: true, exitCode: 0 },
		{ sessionId: "session-current", success: false, exitCode: 0 },
		{ sessionId: "session-current", success: true, exitCode: 1 },
		{ sessionId: "session-current", success: true, exitCode: 0, interrupted: true },
		{ sessionId: "session-current", success: true, exitCode: 0, timedOut: true },
		{ sessionId: "session-current", success: true, exitCode: 0, stopped: true },
		{ sessionId: "session-current", success: true, exitCode: 0, turnBudgetExceeded: true },
	];
	for (const payload of ignored) h.pi.events.emit("subagent:async-complete", payload);

	assert.equal(h.sent.length, 0);
	assert.deepEqual(lastGoal(h), yielded);
});

test("subagent completion latch resets for a later yield epoch", options, async (t) => {
	const h = makeHarness();
	await install(h);
	shutdownAfter(t, h);
	await createYielded(h);
	const completion = { sessionId: "session-current", success: true, exitCode: 0 };

	h.pi.events.emit("subagent:async-complete", completion);
	assert.equal(h.sent.length, 1);
	h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	h.sent.length = 0;
	await h.tools.get("yield_goal").execute("yield-again", { reason: "waiting for another child" }, null, null, h.ctx);
	h.pi.events.emit("subagent:async-complete", completion);

	assert.equal(h.sent.length, 1, "a new yield epoch may queue its own single wake-up");
});

test("subagent completion does not wake non-yielded goal states", options, async (t) => {
	const base = {
		version: 2,
		id: "non-yielded",
		objective: "remain non-yielded",
		tokenBudget: 100,
		tokensUsed: 10,
		timeUsedSeconds: 1,
		createdAt: 1,
		updatedAt: 2,
	};
	const harnesses = [];
	for (const status of ["active", "paused", "complete", "budget_limited"]) {
		const entries = [{ type: "custom", customType: "pi-goal", data: { goal: { ...base, status } } }];
		const h = makeHarness({ entries });
		harnesses.push(h);
		await install(h);
		h.pi.events.emit("subagent:async-complete", { sessionId: "session-current", success: true, exitCode: 0 });
		assert.equal(h.sent.length, 0, `${status} must not wake`);
		assert.equal(lastGoal(h).status, status);
	}
	const cleared = makeHarness({ entries: [{ type: "custom", customType: "pi-goal", data: { goal: null } }] });
	harnesses.push(cleared);
	await install(cleared);
	cleared.pi.events.emit("subagent:async-complete", { sessionId: "session-current", success: true, exitCode: 0 });
	assert.equal(cleared.sent.length, 0, "cleared goal must not wake");
	shutdownAfter(t, ...harnesses);
});
