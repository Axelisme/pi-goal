const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };

// The harness models the session as the tree Pi actually keeps: appends hang off the current
// leaf, and navigation moves that leaf. Without those two facts a discard cannot be observed.
function makeHarness({ runtimeSupport = false, contextTokens, navigation = "real" } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const sent = [];
	const notices = [];
	const compactions = [];
	const navigations = [];
	const commandRuns = [];
	let activeTools = ["create_goal"];
	let appendThrows = false;
	let sendThrows = false;
	let compactThrows = false;
	let pendingMessages = false;
	let idle = true;
	let tokens = contextTokens;
	let leafId = null;
	let nextEntryId = 0;

	function branch() {
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const path = [];
		let cursor = leafId;
		while (cursor) {
			const entry = byId.get(cursor);
			if (!entry) break;
			path.unshift(entry);
			cursor = entry.parentId;
		}
		return path;
	}

	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message, sendOptions) {
			if (sendThrows) throw new Error("runtime inactive");
			sent.push({ message, options: sendOptions });
		},
		sendUserMessage(text, sendOptions) {
			// Pi dispatches a recognized command and returns before building a user message.
			if (sendOptions?.expandPromptTemplates && text.startsWith("/")) {
				const space = text.indexOf(" ");
				const name = space === -1 ? text.slice(1) : text.slice(1, space);
				const args = space === -1 ? "" : text.slice(space + 1);
				const command = commands.get(name);
				if (command) {
					commandRuns.push(Promise.resolve(command.handler(args, commandCtx)));
					return;
				}
			}
			throw new Error(`unrecognized internal user message: ${text}`);
		},
		appendEntry(customType, data) {
			if (appendThrows) throw new Error("durability unavailable");
			nextEntryId += 1;
			const id = `e${nextEntryId}`;
			entries.push({ id, parentId: leafId, type: "custom", customType, data });
			leafId = id;
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
	// Only a command handler receives Pi's command-capable context.
	const commandCtx = Object.create(ctx);
	if (navigation !== "absent") {
		commandCtx.navigateTree = async (targetId, navigateOptions) => {
			navigations.push({ targetId, options: navigateOptions });
			if (navigation === "throw") throw new Error("navigation exploded");
			if (navigation === "cancel") return { cancelled: true };
			// "noop" models a host that binds navigation but never moves the leaf.
			if (navigation === "real") leafId = targetId;
			return { cancelled: false };
		};
	}

	return {
		pi, ctx, commandCtx, handlers, tools, commands, entries, sent, notices, compactions, navigations,
		leaf: () => leafId,
		branchEntries: () => branch(),
		async navigateSession(targetId) {
			const oldLeafId = leafId;
			await handlers.get("session_before_tree")?.({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal }, ctx);
			leafId = targetId;
			await handlers.get("session_tree")?.({ type: "session_tree", oldLeafId, newLeafId: targetId }, ctx);
		},
		async flush() {
			while (commandRuns.length) await commandRuns.shift();
			await Promise.resolve();
		},
		setAppendThrows(value) { appendThrows = value; },
		setSendThrows(value) { sendThrows = value; },
		setCompactThrows(value) { compactThrows = value; },
		setPending(value) { pendingMessages = value; },
		setIdle(value) { idle = value; },
		setContextTokens(value) { tokens = value; },
	};
}

function loadExtension() {
	// A fresh module per install: the extension keeps process-local state and a live timer
	// handle, and one session's leftovers must never reach the next test's clock.
	const jiti = createJiti(resolve(__dirname, "pi-yield-timeout.test.cjs"), {
		moduleCache: false,
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

function timeoutMessages(h) {
	return h.sent.filter((entry) => entry.message.details.kind === "yield_timeout");
}

function discardTokenFrom(h) {
	const content = timeoutMessages(h).at(-1)?.message?.content ?? "";
	return content.match(/discardToken "([^"]+)"/)?.[1] ?? null;
}

// One full cycle: create a goal, yield it, and settle so the branch position is captured.
async function startWait(h, { objective = "await a child", timeoutSeconds = 30 } = {}) {
	await h.tools.get("create_goal").execute("create", { objective }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "child running", timeoutSeconds }, null, null, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
}

async function startAgent(h) {
	await h.handlers.get("turn_start")({ type: "turn_start" }, h.ctx);
}

// Deliver one fallback wake and enter the recheck turn it starts.
async function wake(h, t, seconds = 30) {
	t.mock.timers.tick(seconds * 1000);
	await startAgent(h, "yield timeout");
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

test("a fallback wake reports its cumulative wait and offers the discard token", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await startWait(h);
	h.sent.length = 0;

	t.mock.timers.tick(30_000);
	const first = timeoutMessages(h).at(-1);
	assert.equal(first.message.details.goal.waitTimeouts, 1);
	assert.match(first.message.content, /Wait so far: 1 fallback timeout over/);
	assert.match(first.message.content, /do not assume it completed/);
	const token = discardTokenFrom(h);
	assert.ok(token, "a wake with a captured branch position offers a token");

	// A second wake reports the accumulated count and rotates the token.
	await startAgent(h, "second yield timeout");
	await h.tools.get("yield_goal").execute("yield", { reason: "child still running", timeoutSeconds: 30 }, null, null, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	t.mock.timers.tick(30_000);
	const second = timeoutMessages(h).at(-1);
	assert.equal(second.message.details.goal.waitTimeouts, 2);
	assert.match(second.message.content, /Wait so far: 2 fallback timeouts over/);
	assert.notEqual(discardTokenFrom(h), token, "each wake mints its own token");
});

test("a wake run that ends without yielding cannot donate its token", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await startWait(h);
	await wake(h, t);
	const token = discardTokenFrom(h);
	assert.ok(token);

	// The recheck turn ends without a terminal yield, so pi-goal queues a continuation instead.
	await h.handlers.get("agent_end")({ messages: [] }, h.ctx);
	const result = await h.tools.get("yield_goal").execute("yield", { reason: "still waiting", discardToken: token }, null, null, h.ctx);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.discard.accepted, false);
	assert.match(payload.discard.reason, /no fallback timeout wake is open/);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(h.navigations.length, 0);
});

test("a current token rewinds the recheck and keeps the wait durable", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await startWait(h);
	const anchor = h.leaf();
	await wake(h, t);
	// The recheck turn writes to the branch before yielding again.
	h.pi.appendEntry("scratch", { note: "recheck work" });
	assert.notEqual(h.leaf(), anchor);

	const result = await h.tools.get("yield_goal").execute("yield", { reason: "child still running", timeoutSeconds: 30, discardToken: discardTokenFrom(h) }, null, null, h.ctx);
	assert.equal(JSON.parse(result.content[0].text).discard.accepted, true);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();

	assert.deepEqual(h.navigations.map((entry) => entry.targetId), [anchor]);
	assert.equal(h.navigations[0].options, undefined, "summarization is never requested");
	const restated = lastGoal(h);
	assert.equal(restated.status, "yielded");
	assert.equal(restated.waitTimeouts, 1, "the wait count survives the rewind");
	assert.equal(h.leaf(), h.entries.at(-1).id, "the restated goal becomes the next rewind target");

	// The next cycle rewinds to the restated goal, not to the original anchor.
	const nextTarget = h.leaf();
	await wake(h, t);
	await h.tools.get("yield_goal").execute("yield", { reason: "child still running", timeoutSeconds: 30, discardToken: discardTokenFrom(h) }, null, null, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.deepEqual(h.navigations.map((entry) => entry.targetId), [anchor, nextTarget]);
	assert.equal(lastGoal(h).waitTimeouts, 2);
});

test("a token that is absent, wrong, reused, or over its allowance yields without rewinding", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const cases = [
		{ name: "absent", token: () => undefined, reason: null },
		{ name: "mismatched", token: () => "wake-999-deadbeef", reason: /not the one this fallback timeout wake issued/ },
	];
	for (const current of cases) {
		const h = makeHarness();
		await install(h);
		await startWait(h);
		await wake(h, t);
		const result = await h.tools.get("yield_goal").execute("yield", { reason: "still waiting", timeoutSeconds: 30, discardToken: current.token() }, null, null, h.ctx);
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.discard.accepted, false, current.name);
		assert.equal(payload.discard.requested, current.token() !== undefined, current.name);
		if (current.reason) assert.match(payload.discard.reason, current.reason, current.name);
		assert.equal(payload.timeoutAt !== null, true, `${current.name} still arms its fallback`);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		await h.flush();
		assert.equal(h.navigations.length, 0, current.name);
		assert.equal(lastGoal(h).status, "yielded", current.name);
	}

	// A token is single-use: the yield that consumed it leaves nothing for the next call.
	const reuse = makeHarness();
	await install(reuse);
	await startWait(reuse);
	await wake(reuse, t);
	const token = discardTokenFrom(reuse);
	await reuse.tools.get("yield_goal").execute("yield", { reason: "first", timeoutSeconds: 30, discardToken: token }, null, null, reuse.ctx);
	await reuse.handlers.get("agent_settled")({ type: "agent_settled" }, reuse.ctx);
	await reuse.flush();
	await startAgent(reuse, "second yield timeout");
	const replay = await reuse.tools.get("yield_goal").execute("yield", { reason: "second", timeoutSeconds: 30, discardToken: token }, null, null, reuse.ctx);
	assert.equal(JSON.parse(replay.content[0].text).discard.accepted, false, "a consumed token cannot be replayed");
	assert.equal(reuse.navigations.length, 1);

	// The allowance is the wake's own interval plus 300 seconds of recheck slack.
	const late = makeHarness();
	await install(late);
	await startWait(late, { timeoutSeconds: 30 });
	await wake(late, t);
	t.mock.timers.tick(300_001);
	const lateResult = await late.tools.get("yield_goal").execute("yield", { reason: "slow recheck", timeoutSeconds: 30, discardToken: discardTokenFrom(late) }, null, null, late.ctx);
	const latePayload = JSON.parse(lateResult.content[0].text);
	assert.equal(latePayload.discard.accepted, false);
	assert.match(latePayload.discard.reason, /past the 330 second discard allowance/);
	await late.handlers.get("agent_settled")({ type: "agent_settled" }, late.ctx);
	await late.flush();
	assert.equal(late.navigations.length, 0);
});

test("a rewind that does not land keeps the recheck and warns", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const navigation of ["noop", "cancel", "throw", "absent"]) {
		const h = makeHarness({ navigation });
		await install(h);
		await startWait(h);
		const anchor = h.leaf();
		await wake(h, t);
		await h.tools.get("yield_goal").execute("yield", { reason: "still waiting", timeoutSeconds: 30, discardToken: discardTokenFrom(h) }, null, null, h.ctx);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		await h.flush();

		assert.equal(h.leaf() !== anchor || navigation === "absent", true, navigation);
		assert.match(h.notices.at(-1), /Goal discard kept the recheck|could not rewind/, navigation);
		assert.equal(lastGoal(h).status, "yielded", navigation);
		// The preserved cycle still waits: its fallback timer is intact.
		h.sent.length = 0;
		t.mock.timers.tick(30_000);
		assert.equal(timeoutMessages(h).length, 1, navigation);
	}
});

test("a real external wake ends the wait sequence and revokes discard authority", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await startWait(h);
	await wake(h, t);
	const token = discardTokenFrom(h);
	await h.tools.get("yield_goal").execute("yield", { reason: "child still running", timeoutSeconds: 30, discardToken: token }, null, null, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(lastGoal(h).waitTimeouts, 1);

	// Native input, then a native turn, is a real external wake rather than a fallback recheck.
	await h.handlers.get("input")({ type: "input", text: "the child finished", source: "interactive" }, h.ctx);
	await startAgent(h, "the child finished");
	assert.equal(lastGoal(h).status, "active");
	assert.equal(lastGoal(h).waitStartedAt, undefined, "a real wake ends the sequence");

	const rewindsBefore = h.navigations.length;
	const next = await h.tools.get("yield_goal").execute("yield", { reason: "a different prerequisite", timeoutSeconds: 30, discardToken: token }, null, null, h.ctx);
	const payload = JSON.parse(next.content[0].text);
	assert.equal(payload.discard.accepted, false);
	assert.equal(payload.goal.waitTimeouts, 0, "the next yield starts a fresh sequence");
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(h.navigations.length, rewindsBefore, "the revoked token rewinds nothing");
});

test("a large context compacts once after the yield settles, never at the wake", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 100_001 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "compact after yielding" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	assert.equal(h.compactions.length, 0, "the tool never compacts inside its own operation");

	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(h.compactions.length, 1);
	h.sent.length = 0;
	h.compactions[0].onComplete({});

	// The wake itself never evaluates the threshold.
	t.mock.timers.tick(30_000);
	assert.equal(h.compactions.length, 1);
	assert.equal(timeoutMessages(h).length, 1);
	assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
});

test("settlement rechecks usage, so a context no longer over the threshold is not compacted", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cases = [
		{ name: "still over", after: 100_001, compactions: 1 },
		{ name: "back at the boundary", after: 100_000, compactions: 0 },
		{ name: "unknown", after: null, compactions: 0 },
	];
	for (const current of cases) {
		const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
		await install(h);
		await h.tools.get("create_goal").execute("create", { objective: current.name }, null, null, h.ctx);
		await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
		h.setContextTokens(current.after);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		await h.flush();
		assert.equal(h.compactions.length, current.compactions, current.name);
	}

	// A context at or below the threshold when the yield is made latches nothing at all.
	for (const tokens of [99_999, 100_000, null, undefined]) {
		const h = makeHarness({ runtimeSupport: true, contextTokens: tokens });
		await install(h);
		await h.tools.get("create_goal").execute("create", { objective: `under ${String(tokens)}` }, null, null, h.ctx);
		await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
		h.setContextTokens(500_000);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		await h.flush();
		assert.equal(h.compactions.length, 0, String(tokens));
	}

	// A runtime with no compaction support yields and waits exactly as before.
	const unsupported = makeHarness();
	await install(unsupported);
	await unsupported.tools.get("create_goal").execute("create", { objective: "unsupported" }, null, null, unsupported.ctx);
	await unsupported.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, unsupported.ctx);
	await unsupported.handlers.get("agent_settled")({ type: "agent_settled" }, unsupported.ctx);
	await unsupported.flush();
	unsupported.sent.length = 0;
	t.mock.timers.tick(30_000);
	assert.equal(timeoutMessages(unsupported).length, 1);
});

test("a wake waits for an in-flight yield compaction and delivers once", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "wait for compaction" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	h.sent.length = 0;
	assert.equal(h.compactions.length, 1);

	t.mock.timers.tick(30_000);
	assert.equal(timeoutMessages(h).length, 0, "a wake never lands mid-compaction");
	h.compactions[0].onComplete({});
	assert.equal(timeoutMessages(h).length, 1);
	h.compactions[0].onComplete({});
	assert.equal(timeoutMessages(h).length, 1, "a repeated callback cannot redeliver");
});

test("a busy runtime defers the yield's settlement work until it is idle", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "settle when idle" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, h.ctx);
	h.setIdle(false);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(h.compactions.length, 0);

	t.mock.timers.tick(30_000);
	assert.equal(timeoutMessages(h).length, 0);
	h.setIdle(true);
	await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
	await h.flush();
	assert.equal(h.compactions.length, 1);
	assert.equal(timeoutMessages(h).length, 0);
	h.compactions[0].onComplete({});
	assert.equal(timeoutMessages(h).length, 1);
});

test("compaction failures warn and leave the wait intact", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const callbackFailure = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(callbackFailure);
	await callbackFailure.tools.get("create_goal").execute("create", { objective: "callback fallback" }, null, null, callbackFailure.ctx);
	await callbackFailure.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, callbackFailure.ctx);
	await callbackFailure.handlers.get("agent_settled")({ type: "agent_settled" }, callbackFailure.ctx);
	await callbackFailure.flush();
	callbackFailure.sent.length = 0;
	callbackFailure.compactions[0].onError(new Error("summary failed"));
	assert.match(callbackFailure.notices.at(-1), /compaction failed: Error: summary failed/);
	t.mock.timers.tick(30_000);
	assert.equal(timeoutMessages(callbackFailure).length, 1, "a failed compaction never costs the wake");
	callbackFailure.compactions[0].onError(new Error("duplicate"));
	assert.equal(timeoutMessages(callbackFailure).length, 1);

	const synchronousFailure = makeHarness({ runtimeSupport: true, contextTokens: 150_000 });
	await install(synchronousFailure);
	await synchronousFailure.tools.get("create_goal").execute("create", { objective: "synchronous fallback" }, null, null, synchronousFailure.ctx);
	await synchronousFailure.setCompactThrows(true);
	await synchronousFailure.tools.get("yield_goal").execute("yield", { reason: "waiting", timeoutSeconds: 30 }, null, null, synchronousFailure.ctx);
	await synchronousFailure.handlers.get("agent_settled")({ type: "agent_settled" }, synchronousFailure.ctx);
	await synchronousFailure.flush();
	assert.match(synchronousFailure.notices.at(-1), /compaction failed: Error: compaction request failed/);
	synchronousFailure.sent.length = 0;
	t.mock.timers.tick(30_000);
	assert.equal(timeoutMessages(synchronousFailure).length, 1);
});

test("lifecycle changes revoke a pending discard and its wake", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cases = [
		{ name: "pause", change: async (h) => h.commands.get("goal").handler("pause", h.ctx) },
		{ name: "replacement", change: async (h) => h.commands.get("goal").handler("replacement objective", h.ctx) },
		{ name: "shutdown", change: async (h) => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx) },
		{ name: "reload", change: async (h) => h.handlers.get("session_start")({ reason: "reload" }, h.ctx) },
	];
	for (const current of cases) {
		const h = makeHarness();
		await install(h);
		await startWait(h, { objective: current.name });
		await wake(h, t);
		await h.tools.get("yield_goal").execute("yield", { reason: "still waiting", timeoutSeconds: 30, discardToken: discardTokenFrom(h) }, null, null, h.ctx);
		h.sent.length = 0;

		await current.change(h);
		await h.handlers.get("agent_settled")({ type: "agent_settled" }, h.ctx);
		await h.flush();
		assert.equal(h.navigations.length, 0, current.name);
		t.mock.timers.runAll();
		assert.equal(timeoutMessages(h).length, 0, current.name);
	}
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
	await startAgent(h, "queued native message");
	assert.equal(lastGoal(h).status, "active");
});

test("a native turn before the deadline cancels the fallback wake-up", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await h.tools.get("create_goal").execute("create", { objective: "resume natively" }, null, null, h.ctx);
	await h.tools.get("yield_goal").execute("yield", { reason: "waiting for completion", timeoutSeconds: 30 }, null, null, h.ctx);
	h.sent.length = 0;

	await startAgent(h, "native turn");
	assert.equal(lastGoal(h).status, "active");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 0);
});

test("tree navigation cancels the abandoned branch timeout and restores historical authority paused", options, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = makeHarness();
	await install(h);
	await startWait(h);
	const historicalActive = h.entries.find((entry) => entry.data?.goal?.status === "active");
	assert.ok(historicalActive);
	const entriesBeforeNavigation = h.entries.length;
	h.sent.length = 0;

	await h.navigateSession(historicalActive.id);
	const selectedBranch = h.branchEntries();
	assert.equal(selectedBranch.at(-1).data.goal.status, "paused");
	assert.equal(selectedBranch.at(-1).parentId, historicalActive.id);
	assert.match(h.notices.at(-1), /Goal paused after tree navigation/);

	t.mock.timers.tick(30_000);
	assert.equal(h.sent.length, 0, "the abandoned branch timeout cannot wake the selected branch");
	assert.equal(h.entries.length, entriesBeforeNavigation + 1, "only the selected branch pause is appended");
	assert.equal(h.branchEntries().at(-1).data.goal.status, "paused");
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
	assert.equal(JSON.parse(result.content[0].text).timeoutSeconds, 270);
	assert.equal(lastGoal(h).status, "yielded");
	assert.equal(h.sent.length, 0, "yield itself must not manufacture a wake-up");

	t.mock.timers.tick(269_999);
	assert.equal(h.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.details.kind, "yield_timeout");
	assert.equal(h.sent[0].options.triggerTurn, true);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(lastGoal(h).status, "yielded", "timeout delivery does not acquire authority");

	await startAgent(h);
	assert.equal(lastGoal(h).status, "active");
	assert.equal(h.sent.filter((entry) => entry.message.details.kind === "resumed").length, 0, "the native timeout entry is the sole marker");
	t.mock.timers.runAll();
	assert.equal(h.sent.length, 1, "the timeout is one-shot");
});
