const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi 0.81.1 global runtime is unavailable" };

function makeHarness() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const sent = [];
	const notices = [];
	let activeTools = ["create_goal"];
	let appendThrows = false;
	let sendThrows = false;
	let pendingMessages = false;
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
		isIdle: () => true,
		hasPendingMessages: () => pendingMessages,
	};
	return {
		pi, ctx, handlers, tools, commands, entries, sent, notices,
		setAppendThrows(value) { appendThrows = value; },
		setSendThrows(value) { sendThrows = value; },
		setPending(value) { pendingMessages = value; },
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

test("an invalid timeout leaves the active goal unchanged", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "keep working" }, null, null, h.ctx);
	h.sent.length = 0;

	await assert.rejects(
		h.tools.get("yield_goal").execute("yield", { reason: "bad timeout", timeoutSeconds: 29 }, null, null, h.ctx),
		/timeoutSeconds must be an integer between 30 and 3600 seconds/,
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
