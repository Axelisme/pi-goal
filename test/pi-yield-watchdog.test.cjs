const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };
const minute = 60_000;

function makeHarness({ entries = [], idle = true, contextTokens } = {}) {
	const handlers = new Map();
	const inputHandlers = [];
	const tools = new Map();
	const commands = new Map();
	const sent = [];
	const notices = [];
	const compactions = [];
	let activeTools = ["create_goal"];
	let appendThrows = false;
	let isIdle = idle;
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
		sendMessage(message, sendOptions) {
			sent.push({ message, options: sendOptions, entryCount: entries.length });
		},
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
		hasPendingMessages: () => false,
	};
	if (contextTokens !== undefined) {
		ctx.getContextUsage = () => ({ tokens: contextTokens, contextWindow: 200_000 });
		ctx.compact = (callbacks) => { compactions.push(callbacks); };
	}
	return {
		pi, ctx, handlers, tools, commands, entries, sent, notices, compactions,
		async dispatchInput(event) {
			for (const handler of inputHandlers) {
				const result = await handler(event, ctx);
				if (result?.action === "handled") return result;
			}
			return { action: "continue" };
		},
		setAppendThrows(value) { appendThrows = value; },
		setIdle(value) { isIdle = value; },
	};
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-yield-watchdog.test.cjs"), {
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

async function createGoal(h, objective = "wait for deployment") {
	return h.tools.get("create_goal").execute("create", { objective }, null, null, h.ctx);
}

async function yieldGoal(h, reason = "deployment is unfinished") {
	return h.tools.get("yield_goal").execute("yield", { reason }, null, null, h.ctx);
}

function goalEntries(h) {
	return h.entries.filter((entry) => entry.customType === "pi-goal");
}

function lastGoal(h) {
	return goalEntries(h).at(-1)?.data?.goal;
}

function observations(h) {
	return h.entries.filter((entry) => entry.customType === "pi-goal-observation").map((entry) => entry.data);
}

async function timeoutStatus(h) {
	await h.commands.get("goal").handler("timeout status", h.ctx);
	return h.notices.at(-1);
}

function enableTimers(t) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-09-08T00:00:00.000Z") });
	const nativeSetTimeout = global.setTimeout;
	const nativeClearTimeout = global.clearTimeout;
	const live = new Set();
	global.setTimeout = (callback, delay, ...args) => {
		let handle;
		handle = nativeSetTimeout(() => {
			live.delete(handle);
			callback(...args);
		}, delay);
		live.add(handle);
		return handle;
	};
	global.clearTimeout = (handle) => {
		live.delete(handle);
		return nativeClearTimeout(handle);
	};
	t.after(() => {
		global.setTimeout = nativeSetTimeout;
		global.clearTimeout = nativeClearTimeout;
	});
	return { count: () => live.size };
}

async function assertNoActiveTimeout(h, timers, label) {
	assert.equal(timers.count(), 0, `${label}: no live timer handles`);
	assert.match(await timeoutStatus(h), /Active deadline: none/, `${label}: no active timeout operation`);
}

test("timeout commands expose the default and persist a valid session setting", options, async () => {
	const h = makeHarness();
	await install(h);
	const command = h.commands.get("goal");
	const completions = command.getArgumentCompletions("timeout").map(({ value }) => value);
	assert.deepEqual(completions, ["timeout status", "timeout set "]);
	assert.match(await timeoutStatus(h), /Configured yield timeout: 29m/);
	assert.match(h.notices.at(-1), /Active deadline: none/);

	await command.handler("timeout set 45m", h.ctx);
	assert.match(h.notices.at(-1), /set to 45m/i);
	assert.equal(goalEntries(h).at(-1).data.yieldTimeoutMs, 45 * minute);
	assert.equal(goalEntries(h).at(-1).data.yieldTimeoutLabel, "45m");

	await createGoal(h, "replacement must retain settings");
	assert.equal(goalEntries(h).at(-1).data.yieldTimeoutMs, 45 * minute);
	assert.match(await timeoutStatus(h), /Configured yield timeout: 45m/);

	const restoredEntries = h.entries.map((entry) => structuredClone(entry));
	const restored = makeHarness({ entries: restoredEntries });
	await install(restored);
	assert.match(await timeoutStatus(restored), /Configured yield timeout: 45m/);
});

test("timeout set accepts case-insensitive positive integer units and rejects invalid input atomically", options, async () => {
	for (const [input, expectedMs, expectedLabel] of [["1s", 1_000, "1s"], ["2M", 2 * minute, "2m"], ["1H", 60 * minute, "1h"]]) {
		const h = makeHarness();
		await install(h);
		await h.commands.get("goal").handler(`timeout set ${input}`, h.ctx);
		assert.equal(goalEntries(h).at(-1).data.yieldTimeoutMs, expectedMs, input);
		assert.equal(goalEntries(h).at(-1).data.yieldTimeoutLabel, expectedLabel, input);
	}

	const invalid = ["timeout", "timeout set", "timeout set 0s", "timeout set -1s", "timeout set 1.5m", "timeout set 2d", "timeout set 1s extra", "timeout set 2147483648ms", "timeout set 597h"];
	for (const input of invalid) {
		const h = makeHarness();
		await install(h);
		await h.commands.get("goal").handler("timeout set 5m", h.ctx);
		const before = goalEntries(h).length;
		await h.commands.get("goal").handler(input, h.ctx);
		assert.equal(goalEntries(h).length, before, input);
		assert.match(h.notices.at(-1), /timeout|duration|usage/i, input);
		assert.match(await timeoutStatus(h), /Configured yield timeout: 5m/, input);
	}
});

test("malformed persisted settings fall back to 29m without changing goal schema", options, async () => {
	const malformed = [
		{ yieldTimeoutMs: 0, yieldTimeoutLabel: "0s" },
		{ yieldTimeoutMs: 1_000, yieldTimeoutLabel: "wrong" },
		{ yieldTimeoutMs: 2_147_483_648, yieldTimeoutLabel: "597h" },
		{ yieldTimeoutMs: "1000", yieldTimeoutLabel: "1s" },
	];
	for (const data of malformed) {
		const entry = { id: "old", parentId: null, type: "custom", customType: "pi-goal", data: { goal: null, statusBarEnabled: true, ...data } };
		const h = makeHarness({ entries: [entry] });
		await install(h);
		assert.match(await timeoutStatus(h), /Configured yield timeout: 29m/);
	}
});

test("an armed wait reports its fixed deadline and timeout set affects only the next yield", options, async (t) => {
	const timers = enableTimers(t);
	const h = makeHarness();
	await install(h);
	await createGoal(h);
	await yieldGoal(h);
	const first = await timeoutStatus(h);
	assert.match(first, /Configured yield timeout: 29m/);
	assert.match(first, /Active deadline: 2026-09-08T00:29:00.000Z/);
	assert.match(first, /Remaining: 1740s/);

	await h.commands.get("goal").handler("timeout set 1h", h.ctx);
	const changed = await timeoutStatus(h);
	assert.match(changed, /Configured yield timeout: 1h/);
	assert.match(changed, /Active deadline: 2026-09-08T00:29:00.000Z/);
	t.mock.timers.tick(29 * minute);
	assert.equal(lastGoal(h).status, "yielded");
	await assertNoActiveTimeout(h, timers, "delivered configured deadline");
});

test("deadline keeps the goal yielded until its one timeout follow-up starts", options, async (t) => {
	const timers = enableTimers(t);
	const h = makeHarness();
	await install(h);
	await h.commands.get("goal").handler("timeout set 1s", h.ctx);
	await createGoal(h);
	h.sent.length = 0;
	await yieldGoal(h, "deployment is unfinished");
	const waitId = lastGoal(h).waitId;
	const waitStartedAt = lastGoal(h).waitStartedAt;
	const waitTimeouts = lastGoal(h).waitTimeouts;
	t.mock.timers.tick(1_000);

	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(lastGoal(h).waitId, waitId);
	assert.equal(lastGoal(h).waitStartedAt, waitStartedAt);
	assert.equal(lastGoal(h).waitTimeouts, waitTimeouts);
	assert.equal(observations(h).filter((entry) => entry.kind === "wait_ended" && entry.waitId === waitId).length, 0);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].entryCount, h.entries.length, "durable yielded state precedes publication");
	assert.equal(h.sent[0].message.details.kind, "timeout");
	assert.equal(h.sent[0].message.details.goal.status, "yielded");
	assert.match(h.sent[0].message.content, /deployment is unfinished/);
	assert.doesNotMatch(h.sent[0].message.content, /paused|stop pursuing|do not continue/i);
	assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });

	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(lastGoal(h).waitId, undefined);
	const ended = observations(h).filter((entry) => entry.kind === "wait_ended" && entry.waitId === waitId);
	assert.equal(ended.length, 1);
	assert.equal(ended[0].terminationReason, "native_wake");

	t.mock.timers.tick(60 * minute);
	assert.equal(h.sent.length, 1);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	assert.equal(h.sent.length, 1);
	await assertNoActiveTimeout(h, timers, "one-shot delivery");
});

test("a real turn cancels timeout while an input candidate alone does not", options, async (t) => {
	const timers = enableTimers(t);
	const candidate = makeHarness();
	await install(candidate);
	await candidate.commands.get("goal").handler("timeout set 1s", candidate.ctx);
	await createGoal(candidate);
	await yieldGoal(candidate);
	await candidate.dispatchInput({ type: "input", source: "interactive", text: "candidate only" });
	t.mock.timers.tick(1_000);
	assert.equal(lastGoal(candidate).status, "yielded");
	assert.equal(candidate.sent.at(-1).message.details.kind, "timeout");
	await assertNoActiveTimeout(candidate, timers, "input candidate timeout");

	const native = makeHarness();
	await install(native);
	await native.commands.get("goal").handler("timeout set 1s", native.ctx);
	await createGoal(native);
	await yieldGoal(native);
	native.sent.length = 0;
	await native.handlers.get("turn_start")({ type: "turn_start" }, native.ctx);
	t.mock.timers.tick(1_000);
	assert.equal(lastGoal(native).status, "active");
	assert.equal(native.sent.length, 0);
	assert.equal(observations(native).at(-1).terminationReason, "native_wake");
	await assertNoActiveTimeout(native, timers, "native wake");
});

test("a due watchdog waits for idle settlement and still delivers at most once", options, async (t) => {
	const timers = enableTimers(t);
	const h = makeHarness({ idle: false });
	await install(h);
	await h.commands.get("goal").handler("timeout set 1s", h.ctx);
	await createGoal(h);
	h.sent.length = 0;
	await yieldGoal(h);
	t.mock.timers.tick(1_000);
	assert.equal(timers.count(), 0, "the fired handle is consumed while delivery waits");
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0);
	assert.match(await timeoutStatus(h), /Active deadline: 2026-09-08T00:00:01.000Z/);
	assert.match(h.notices.at(-1), /Remaining: 0s/);

	h.setIdle(true);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 1);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	t.mock.timers.tick(60 * minute);
	assert.equal(h.sent.length, 1);
	await assertNoActiveTimeout(h, timers, "settled due operation");
});

test("a timeout due during compaction delivers once after completion or error", options, async (t) => {
	const timers = enableTimers(t);
	for (const outcome of ["complete", "error"]) {
		const h = makeHarness({ contextTokens: 150_000 });
		await install(h);
		await h.commands.get("goal").handler("timeout set 1s", h.ctx);
		await createGoal(h, `compaction ${outcome}`);
		h.sent.length = 0;
		await yieldGoal(h);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		assert.equal(h.compactions.length, 1, `${outcome}: compaction started`);

		t.mock.timers.tick(1_000);
		assert.equal(lastGoal(h).status, "yielded", `${outcome}: due operation waits for compaction`);
		assert.equal(h.sent.length, 0, `${outcome}: no early delivery`);
		assert.equal(timers.count(), 0, `${outcome}: fired timer handle consumed`);
		assert.match(await timeoutStatus(h), /Remaining: 0s/, `${outcome}: due status is clamped`);

		if (outcome === "complete") h.compactions[0].onComplete({});
		else h.compactions[0].onError(new Error("compaction failed"));
		assert.equal(lastGoal(h).status, "yielded", `${outcome}: timeout keeps the goal yielded after compaction settles`);
		assert.equal(h.sent.filter(({ message }) => message.details?.kind === "timeout").length, 1, `${outcome}: one timeout delivery`);

		h.compactions[0].onComplete({});
		h.compactions[0].onError(new Error("late duplicate"));
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		t.mock.timers.tick(60 * minute);
		assert.equal(h.sent.filter(({ message }) => message.details?.kind === "timeout").length, 1, `${outcome}: no duplicate delivery`);
		await assertNoActiveTimeout(h, timers, `compaction ${outcome}`);
	}
});

test("a stale compaction callback cannot release a newer wait", options, async (t) => {
	const timers = enableTimers(t);
	for (const staleCallback of ["complete", "error"]) {
		const h = makeHarness({ contextTokens: 150_000 });
		await install(h);
		await h.commands.get("goal").handler("timeout set 1s", h.ctx);
		await createGoal(h, `old ${staleCallback}`);
		await yieldGoal(h);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		assert.equal(h.compactions.length, 1, `${staleCallback}: old compaction started`);

		await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
		await createGoal(h, `new ${staleCallback}`);
		await yieldGoal(h);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		assert.equal(h.compactions.length, 2, `${staleCallback}: new compaction started`);
		h.sent.length = 0;

		if (staleCallback === "complete") h.compactions[0].onComplete({});
		else h.compactions[0].onError(new Error("late old compaction"));
		t.mock.timers.tick(1_000);
		assert.equal(lastGoal(h).status, "yielded", `${staleCallback}: old callback cannot release new compaction`);
		assert.equal(h.sent.filter(({ message }) => message.details?.kind === "timeout").length, 0, `${staleCallback}: no delivery before new compaction settles`);

		h.compactions[1].onComplete({});
		assert.equal(lastGoal(h).status, "yielded", `${staleCallback}: new owner releases timeout without pausing`);
		assert.equal(h.sent.filter(({ message }) => message.details?.kind === "timeout").length, 1, `${staleCallback}: exactly one delivery`);
		await assertNoActiveTimeout(h, timers, `stale compaction ${staleCallback}`);
	}
});

test("lifecycle boundaries revoke a stale timeout", options, async (t) => {
	const timers = enableTimers(t);
	for (const transition of ["pause", "clear", "replace", "reload", "tree", "interrupt", "shutdown"]) {
		const h = makeHarness();
		await install(h);
		await h.commands.get("goal").handler("timeout set 1s", h.ctx);
		await createGoal(h, transition);
		await yieldGoal(h);
		assert.match(await timeoutStatus(h), /Active deadline: .*Z/);
		h.sent.length = 0;

		if (transition === "pause") await h.commands.get("goal").handler("pause", h.ctx);
		if (transition === "clear") await h.commands.get("goal").handler("clear", h.ctx);
		if (transition === "replace") await createGoal(h, "replacement");
		if (transition === "reload") await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
		if (transition === "tree") {
			await h.handlers.get("session_before_tree")({}, h.ctx);
			await h.handlers.get("session_tree")({}, h.ctx);
		}
		if (transition === "interrupt") {
			await h.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		}
		if (transition === "shutdown") await h.handlers.get("session_shutdown")({}, h.ctx);

		t.mock.timers.tick(1_000);
		assert.equal(h.sent.some(({ message }) => message.details?.kind === "timeout"), false, transition);
		await assertNoActiveTimeout(h, timers, transition);
	}
});

test("failed yield persistence and failed timeout persistence publish no timeout follow-up", options, async (t) => {
	const timers = enableTimers(t);
	const failedYield = makeHarness();
	await install(failedYield);
	await createGoal(failedYield);
	failedYield.setAppendThrows(true);
	await yieldGoal(failedYield);
	failedYield.setAppendThrows(false);
	t.mock.timers.tick(29 * minute);
	assert.equal(failedYield.sent.filter(({ message }) => message.details?.kind === "timeout").length, 0);
	await assertNoActiveTimeout(failedYield, timers, "failed yield persistence");

	const failedTimeout = makeHarness();
	await install(failedTimeout);
	await failedTimeout.commands.get("goal").handler("timeout set 1s", failedTimeout.ctx);
	await createGoal(failedTimeout);
	await yieldGoal(failedTimeout);
	assert.match(await timeoutStatus(failedTimeout), /Active deadline: .*Z/);
	failedTimeout.sent.length = 0;
	failedTimeout.setAppendThrows(true);
	t.mock.timers.tick(1_000);
	failedTimeout.setAppendThrows(false);
	assert.equal(failedTimeout.sent.length, 0);
	t.mock.timers.tick(60 * minute);
	assert.equal(failedTimeout.sent.length, 0);
	await assertNoActiveTimeout(failedTimeout, timers, "failed timeout persistence");
});
