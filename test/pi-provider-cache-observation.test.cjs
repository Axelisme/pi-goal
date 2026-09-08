const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const options = existsSync(globalPi) ? {} : { skip: "Pi global runtime is unavailable" };

function makeHarness() {
	const handlers = new Map();
	const entries = [];
	const notices = [];
	let activeTools = [];
	let appendThrows = false;
	let model = { provider: "openai-codex", id: "gpt-cache-test" };

	const pi = {
		on(name, handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		appendEntry(customType, data) {
			if (appendThrows) throw new Error("durability unavailable");
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() { return activeTools; },
		setActiveTools(next) { activeTools = next; },
	};
	const ctx = {
		get model() { return model; },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			setStatus() {},
			notify(message) { notices.push(String(message)); },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	};

	return {
		pi, ctx, handlers, entries, notices,
		setAppendThrows(value) { appendThrows = value; },
		setModel(next) { model = next; },
		async emit(name, event) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
			return results;
		},
	};
}

function loadExtension() {
	const jiti = createJiti(resolve(__dirname, "pi-provider-cache-observation.test.cjs"), {
		moduleCache: false,
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	return jiti("../.pi/extensions/pi-goal/index.ts").default;
}

function assistant(usage = { input: 311, cacheRead: 1024, cacheWrite: 0 }) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-cache-test",
		usage: {
			...usage,
			output: 7,
			totalTokens: 1342,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function observations(h) {
	return h.entries
		.filter((entry) => entry.customType === "pi-goal-observation" && entry.data?.kind === "provider_cache")
		.map((entry) => entry.data);
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

const firstPayload = {
	instructions: "cache contract secret",
	tools: [{ type: "function", name: "secret_tool", description: "never persist me" }],
	input: [{ role: "user", content: "private prompt alpha" }],
};
const secondPayload = {
	instructions: "cache contract secret",
	tools: [{ type: "function", name: "secret_tool", description: "never persist me" }],
	input: [{ role: "user", content: "private prompt beta" }],
};

async function install() {
	const h = makeHarness();
	loadExtension()(h.pi);
	return h;
}

test("registered provider hooks append usage and separate segment fingerprints without plaintext", options, async () => {
	const h = await install();
	const frozenFirst = deepFreeze(structuredClone(firstPayload));
	const snapshot = structuredClone(frozenFirst);
	assert.deepEqual(await h.emit("before_provider_request", { type: "before_provider_request", payload: frozenFirst }), [undefined]);
	assert.deepEqual(frozenFirst, snapshot);
	await h.emit("message_end", { type: "message_end", message: assistant() });

	const frozenSecond = deepFreeze(structuredClone(secondPayload));
	assert.deepEqual(await h.emit("before_provider_request", { type: "before_provider_request", payload: frozenSecond }), [undefined]);
	await h.emit("message_end", { type: "message_end", message: assistant({ input: 287, cacheRead: 2048, cacheWrite: 0 }) });

	const [first, second] = observations(h);
	assert.equal(observations(h).length, 2);
	assert.equal(first.version, 1);
	assert.equal(first.provider, "openai-codex");
	assert.equal(first.model, "gpt-cache-test");
	assert.deepEqual(first.usage, { input: 311, cacheRead: 1024, cacheWrite: 0 });
	assert.match(first.observationId, /^observation-/);
	assert.match(first.requestId, /^request-/);
	assert.equal(typeof first.timestamp, "number");
	assert.deepEqual(first.segments.instructions, {
		available: true,
		bytes: 23,
		sha256: "39efbd8352e5713a5cd28141ce542eb7ee73ee4aa6ac7202a06a8497cc014392",
		lcpBytes: null,
		comparedToRequestId: null,
	});
	assert.deepEqual(first.segments.tools, {
		available: true,
		bytes: 75,
		sha256: "ddc1e5e62e8e624e479af69ea415a7a0d69c2c4094bafc733bfb690db0123252",
		lcpBytes: null,
		comparedToRequestId: null,
	});
	assert.deepEqual(first.segments.input, {
		available: true,
		bytes: 50,
		sha256: "a43cc9232f8b3909759bbdd8f7f7f81404875978136419a7028308d753d6035b",
		lcpBytes: null,
		comparedToRequestId: null,
	});
	assert.deepEqual(second.usage, { input: 287, cacheRead: 2048, cacheWrite: 0 });
	assert.equal(second.segments.instructions.lcpBytes, 23);
	assert.equal(second.segments.tools.lcpBytes, 75);
	assert.equal(second.segments.input.lcpBytes, 42);
	assert.equal(second.segments.input.bytes, 49);
	assert.equal(second.segments.input.sha256, "c8ca42089dd39aed2f46a77d227e63ffd0886c15bf0a3a39e72dd5246e99cf7b");
	for (const segment of Object.values(second.segments)) assert.equal(segment.comparedToRequestId, first.requestId);

	const persisted = JSON.stringify(observations(h));
	for (const secret of ["cache contract secret", "secret_tool", "never persist me", "private prompt alpha", "private prompt beta"]) {
		assert.equal(persisted.includes(secret), false, `observation excludes ${secret}`);
	}
});

test("missing segments are unavailable and provider/model comparisons remain isolated", options, async () => {
	const h = await install();
	await h.emit("before_provider_request", { type: "before_provider_request", payload: { messages: ["provider private"] } });
	await h.emit("message_end", { type: "message_end", message: assistant() });
	assert.deepEqual(observations(h)[0].segments, {
		instructions: { available: false },
		tools: { available: false },
		input: { available: false },
	});

	h.setModel({ provider: "anthropic", id: "claude-cache-test" });
	await h.emit("before_provider_request", { type: "before_provider_request", payload: secondPayload });
	await h.emit("message_end", {
		type: "message_end",
		message: { ...assistant(), provider: "anthropic", model: "claude-cache-test" },
	});
	const switched = observations(h).at(-1);
	for (const segment of Object.values(switched.segments)) {
		assert.equal(segment.lcpBytes, null);
		assert.equal(segment.comparedToRequestId, null);
	}
});

test("session start drops unmatched request state before later assistant usage", options, async () => {
	const h = await install();
	await h.emit("message_end", { type: "message_end", message: assistant() });
	assert.equal(observations(h).length, 0);

	await h.emit("before_provider_request", { type: "before_provider_request", payload: firstPayload });
	await h.emit("session_start", { type: "session_start", reason: "reload" });
	await h.emit("message_end", { type: "message_end", message: assistant() });
	assert.equal(observations(h).length, 0);

	await h.emit("before_provider_request", { type: "before_provider_request", payload: secondPayload });
	await h.emit("message_end", { type: "message_end", message: assistant() });
	const afterReload = observations(h)[0];
	for (const segment of Object.values(afterReload.segments)) {
		assert.equal(segment.lcpBytes, null);
		assert.equal(segment.comparedToRequestId, null);
	}
});

test("segment serialization failure leaves the provider request unchanged", options, async () => {
	const h = await install();
	const circular = {};
	circular.instructions = circular;
	const beforeResults = await h.emit("before_provider_request", { type: "before_provider_request", payload: circular });
	assert.deepEqual(beforeResults, [undefined]);
	assert.equal(observations(h).length, 0);
	assert.equal(h.notices.some((notice) => notice.includes("payload segment")), true);
});

test("malformed usage leaves the assistant message unchanged and records no observation", options, async () => {
	const h = await install();
	await h.emit("before_provider_request", { type: "before_provider_request", payload: firstPayload });
	const message = assistant({ input: Number.NaN, cacheRead: -1, cacheWrite: undefined });
	const original = structuredClone(message);
	const messageResults = await h.emit("message_end", { type: "message_end", message });
	assert.deepEqual(message, original);
	assert.equal(messageResults.every((result) => result === undefined), true);
	assert.equal(observations(h).length, 0);
	assert.equal(h.notices.some((notice) => notice.includes("usage was unavailable or invalid")), true);
});

test("durability failure leaves the assistant message unchanged and does not escape", options, async () => {
	const h = await install();
	await h.emit("before_provider_request", { type: "before_provider_request", payload: firstPayload });
	h.setAppendThrows(true);
	const message = assistant();
	const original = structuredClone(message);
	const messageResults = await h.emit("message_end", { type: "message_end", message });
	assert.deepEqual(message, original);
	assert.equal(messageResults.every((result) => result === undefined), true);
	assert.equal(observations(h).length, 0);
	assert.equal(h.notices.some((notice) => notice.includes("not durable")), true);
});
