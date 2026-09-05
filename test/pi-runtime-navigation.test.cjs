// pi-goal reaches session navigation only from a command handler, and it treats the resulting
// leaf rather than the returned flag as the postcondition. Both facts belong to Pi, not to this
// extension, so they are exercised against the installed runtime instead of the fake harness.
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const installedVersion = existsSync(join(globalPi, "package.json"))
	? JSON.parse(readFileSync(join(globalPi, "package.json"), "utf8")).version
	: null;
// This runs against whatever Pi is installed rather than one pinned build. Drift in the split
// below is exactly what the extension needs to hear about, so a newer Pi must fail here loudly
// instead of skipping quietly. Validated against 0.85.x.
const options = installedVersion ? {} : { skip: "no Pi runtime is installed" };

const noop = () => {};

function makeRunner({ bindNavigation } = {}) {
	const { ExtensionRunner } = require(join(globalPi, "dist/core/extensions/runner.js"));
	const navigations = [];
	let leafId = "leaf-before";
	const sessionManager = {
		getCwd: () => "/tmp",
		getLeafId: () => leafId,
		getEntries: () => [],
		getBranch: () => [],
	};
	const runtime = {
		sendMessage: noop,
		sendUserMessage: noop,
		appendEntry: noop,
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		flagValues: new Map(),
	};
	const runner = new ExtensionRunner([], runtime, "/tmp", sessionManager, {});
	runner.bindCore(
		{
			sendMessage: noop, sendUserMessage: noop, appendEntry: noop, setSessionName: noop,
			getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [],
			setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop,
			getThinkingLevel: () => "off", setThinkingLevel: noop,
		},
		{
			getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
			isProjectTrusted: () => true, getSignal: () => undefined, abort: noop,
			hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined,
			compact: noop, getSystemPrompt: () => "",
		},
	);
	runner.bindCommandContext(bindNavigation
		? {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async (targetId, navigateOptions) => {
				navigations.push({ targetId, options: navigateOptions });
				leafId = targetId;
				return { cancelled: false };
			},
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		}
		: undefined);
	return { runner, navigations, sessionManager, leaf: () => leafId };
}

test("only a command handler's context can navigate the session tree", options, () => {
	const { runner } = makeRunner({ bindNavigation: true });
	// Tools and ordinary event handlers receive this context; pi-goal's rewind bridge exists
	// because it cannot navigate from there.
	assert.equal(typeof runner.createContext().navigateTree, "undefined", `Pi ${installedVersion}`);
	assert.equal(typeof runner.createCommandContext().navigateTree, "function");
});

test("a bound navigation moves the leaf and forwards the caller's options verbatim", options, async () => {
	const harness = makeRunner({ bindNavigation: true });
	const ctx = harness.runner.createCommandContext();
	const result = await ctx.navigateTree("leaf-after");
	assert.equal(result.cancelled, false);
	assert.equal(harness.leaf(), "leaf-after");
	assert.deepEqual(harness.navigations, [{ targetId: "leaf-after", options: undefined }]);
	// Omitting options is what keeps a rewind free of a branch summary.
	assert.equal(harness.navigations[0].options, undefined);
});

test("an unbound host reports success without moving the leaf", options, async () => {
	const harness = makeRunner({ bindNavigation: false });
	const ctx = harness.runner.createCommandContext();
	const before = harness.leaf();
	const result = await ctx.navigateTree("leaf-after");
	// This is why pi-goal's postcondition is the resulting leaf and never the returned flag:
	// a host that binds no command actions answers cancelled:false and changes nothing.
	assert.equal(result.cancelled, false);
	assert.equal(harness.leaf(), before);
	assert.deepEqual(harness.navigations, []);
});
