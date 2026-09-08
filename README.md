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

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, calls `yield_goal({ reason, expect_wake_by })`, the user pauses/clears or interrupts it, or the token budget is reached. Interrupting an active run (for example with Esc in the TUI) automatically persists the goal as paused, so `agent_end` cannot immediately start another continuation. `yield_goal` is a terminal handoff: it requires a bounded reason and an explicit expected source (`user` or `event`), stops immediate automatic continuation, and waits for a real future agent turn. This first tracer deliberately buys no heartbeat and creates no hidden diagnostic timer, including across the approved 270-second cache window. A pending native message is handled by Pi's normal lifecycle; `turn_start` acquires goal authority before provider work, and pi-goal does not add a transient resume marker or synthesize a user message. Source attribution is committed only after Pi accepts an input through its pipeline; handled inputs, unresolved or overlapping input candidates, and unrelated custom-message turns remain `unknown`. The persistent native input that started the turn remains the sole wake marker across later provider requests. Expected source is a policy hint rather than a notification filter: only one unambiguously correlated accepted interactive input is observed as `user`, while RPC, extension, and otherwise unidentifiable wakes remain `unknown`. Reload/restore, shutdown, replacement, pause, clear, interruption, and session-tree navigation end or truncate the old wait and revoke autonomous authority. The optional `discardToken` is accepted only as a shape-compatible field; this tracer issues no recheck token and therefore grants no rewind authority.

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
- `yield_goal({ reason, expect_wake_by, discardToken? })` tool: terminally return control while awaiting a future user or event; the reason is normalized and bounded, and the conservative first tracer waits without a heartbeat
- all four goal tools remain exposed throughout the session so lifecycle changes do not mutate the provider's cached tool schemas; each tool validates the current goal state when called, and invalid `yield_goal` or `update_goal` calls return an error
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`, shown on its own final footer line

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> queue another continuation on agent_end while active
  -> yield_goal validates `expect_wake_by`, persists `yielded`, and emits no immediate continuation
  -> the runtime waits quietly; no synthetic heartbeat or diagnostic poll is armed
  -> a native Pi turn ends the wait and keeps its persistent wake entry as the sole marker
  -> wait start, policy decision, and wait end metadata are appended outside LLM context
  -> after a yield settles, a context over 100k tokens is compacted once
  -> pause when the user interrupts an active run, without queuing a wake-up message
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"` using schema version 4. Valid version-1 through version-3 records migrate their known objective, status, accounting, and historical wait count without guessing a source or creating a new model sample. A fresh legal yield records a stable `waitId`, expected source, start time, and conservative policy reason. A real native wake or lifecycle boundary ends the wait before persistence; reload/restore and session-tree navigation pause rather than silently resume. Wait observations use `customType: "pi-goal-observation"` and contain only bounded identities, timestamps, source classification, termination reason, and policy metadata, so they do not enter provider context. Malformed state fails safe without autonomous continuation. Goal state follows the active session branch and does not require an external database.

## License

MIT
