# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Persistent autonomous goals for [pi](https://github.com/badlogic/pi-mono).

`pi-goal` adds a `/goal` command and goal tools so Pi can keep working toward a long-running, thread-scoped objective until the goal is complete, yielded, paused, cleared, or token-budget-limited.

## Install

```bash
pi install npm:pi-goal
```

Or from git:

```bash
pi install git:github.com/Michaelliv/pi-goal
```

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride along as the content of that custom message, so the model always has the objective and audit guidance in the transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, calls `yield_goal({ reason })`, the user pauses/clears it, or the token budget is reached. `yield_goal` is a terminal handoff: it requires a concise bounded reason, stops immediate automatic continuation, and waits for a real future agent turn. To prevent an accidental yield from blocking forever, it arms a one-shot five-minute fallback timeout by default; `timeoutSeconds` may select a bounded 30–3600 second recheck window. A pending native message takes precedence and resumes the goal before the fallback. Timeout expiry asks the agent to reassess and does not mean the prerequisite completed. Reloading/restoring Pi clears the timer and converts a yielded goal to paused instead of silently resuming it; use `/goal resume` to continue.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can only mark the goal `complete`
- `yield_goal({ reason, timeoutSeconds? })` tool: terminally return control while awaiting a future external prerequisite; the reason is normalized and bounded, and a one-shot fallback rechecks after 300 seconds by default
- `get_goal`, `update_goal`, and `yield_goal` remain exposed while a goal is `active` or `yielded` so a provider request snapshotted before `turn_start` retains the goal contract; continuation authority is still disabled while yielded, and paused, cleared, complete, and budget-limited goals hide them
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> queue another continuation on agent_end while active
  -> yield_goal persists `yielded`, arms one fallback timeout, and emits no immediate continuation
  -> a native event resumes first, or timeout expiry queues one recheck turn
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"` using schema version 2. Valid version-1 records migrate losslessly. Unknown or malformed records fail safe without autonomous continuation. A yielded state records its bounded diagnostic reason and timestamp. Its fallback timer is process-local rather than persisted: native turns cancel it, and reload/session restore clears it and converts yielded to paused. Goal state follows the active session branch and does not require an external database.

## License

MIT
