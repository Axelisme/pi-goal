const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const globalPi = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const available = existsSync(globalPi);
const testOptions = available ? {} : { skip: "Pi global runtime is unavailable" };

test("goal status occupies the footer's final line", testOptions, () => {
	const jiti = createJiti(resolve(__dirname, "footer.test.cjs"), {
		alias: {
			"@mariozechner/pi-tui": `${globalPi}/node_modules/@earendil-works/pi-tui`,
			"@mariozechner/pi-coding-agent": globalPi,
		},
	});
	const { createGoalFooter } = jiti("../.pi/extensions/pi-goal/footer.ts");
	const statuses = new Map([
		["pi-goal", "Pursuing goal (2m)"],
		["worker", "2 subagents running"],
	]);
	const ctx = {
		cwd: "/tmp/project",
		model: { id: "test-model", provider: "test", reasoning: false, contextWindow: 100_000 },
		thinkingLevel: "off",
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
		sessionManager: { getEntries: () => [], getSessionName: () => undefined },
	};
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const component = createGoalFooter(
		ctx,
		{ requestRender() {} },
		{ fg: (_color, text) => text },
		footerData,
		{ statusKey: "pi-goal", goalStatus: () => statuses.get("pi-goal") },
	);

	const lines = component.render(80);
	assert.equal(lines.at(-2), "2 subagents running");
	assert.equal(lines.at(-1), "Pursuing goal (2m)");
	assert.equal(lines.filter((line) => line.includes("Pursuing goal")).length, 1);
});
