const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");
const goalStateSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/goal-state.ts"), "utf8");
const readme = readFileSync(join(__dirname, "../README.md"), "utf8");

test("create_goal tool carries strong goal-writing contract", () => {
	assert.match(indexSource, /A goal must be a durable, evidence-checkable work contract/);
	for (const phrase of [
		"outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition",
		"Do not infer goals from ordinary coding tasks or one-off prompts",
		"Use this objective shape when possible",
		"verified by <specific evidence>, while preserving <constraints>",
		"Prefer a self-contained objective that survives continuation turns and context compaction",
		"ask a clarifying question if missing success criteria or boundaries materially affect the contract",
	]) {
		assert.match(indexSource, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("create_goal uses upsert semantics for explicitly requested goals", () => {
	assert.match(indexSource, /sets or replaces the current thread goal/);
	assert.match(indexSource, /When called, create_goal replaces any existing goal with the new objective/);
	assert.doesNotMatch(indexSource, /replaceExisting/);
	assert.doesNotMatch(indexSource, /This thread already has a goal/);
});

test("update_goal remains completion-only in schema and guidance", () => {
	assert.match(indexSource, /name: "update_goal"/);
	assert.match(indexSource, /enum: \["complete"\]/);
	assert.match(indexSource, /Do not use update_goal to pause, resume, abandon, or budget-limit a goal/);
});

test("yield_goal is terminal with a bounded one-shot fallback timeout", () => {
	assert.match(indexSource, /name: "yield_goal"/);
	assert.match(indexSource, /reason is required/);
	assert.match(indexSource, /terminate: true/);
	assert.match(indexSource, /terminalAction: "yield"/);
	assert.match(indexSource, /timeoutSeconds/);
	assert.match(indexSource, /setTimeout/);
	assert.match(indexSource, /clearTimeout/);
	assert.match(indexSource, /pi\.on\("session_shutdown"/);
	assert.match(indexSource, /do not assume it completed/);
	assert.match(goalStateSource, /DEFAULT_YIELD_TIMEOUT_SECONDS = 300/);
	assert.match(goalStateSource, /status: "yielded"/);
	assert.doesNotMatch(indexSource, /isTerminal: true/);
	assert.match(indexSource, /pi\.on\("message_end"/);
	assert.doesNotMatch(indexSource, /ctx\\.abort\\(\\)/);
	assert.doesNotMatch(indexSource, /setInterval/);
	assert.match(indexSource, /type PersistenceClass = "acquire" \| "retain" \| "revoke"/);
	assert.doesNotMatch(indexSource, /failClosedTo/);
	assert.match(indexSource, /persisted: outcome\.persisted/);
});

test("README documents goal accounting and yield fallback contracts", () => {
	assert.match(readme, /`create_goal` tool: model can set or replace the current goal only when explicitly requested/);
	assert.match(readme, /The final turn is still accounted even when the model completes the goal mid-turn/);
	assert.match(readme, /five-minute fallback timeout/);
	assert.match(readme, /does not mean the prerequisite completed/);
	assert.match(readme, /Reloading\/restoring Pi clears the timer and converts a yielded goal to paused/);
});
