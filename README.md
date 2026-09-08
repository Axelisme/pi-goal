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

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, calls `yield_goal({ reason })`, the user pauses/clears or interrupts it, or the token budget is reached. Interrupting an active run (for example with Esc in the TUI) automatically persists the goal as paused, so `agent_end` cannot immediately start another continuation. `yield_goal` is a terminal handoff: it requires a concise bounded reason, stops immediate automatic continuation, and waits for a real future agent turn. To refresh a cache heartbeat before a five-minute idle boundary, it arms a one-shot 270-second fallback timeout by default; `timeoutSeconds` may select a bounded 30–600 second recheck window. A pending native message takes precedence and resumes the goal before the fallback. Timeout expiry asks the agent to reassess and does not mean the prerequisite completed, and the 270-second interval is not a guarantee of a provider prompt-cache hit. When a yielded goal wakes, the persistent native input that started the turn is its sole marker: timeout uses a pi-goal custom message, while manual and external wakes keep their original user or custom message. `turn_start` acquires goal authority before provider work, and later requests in the same run retain the wake entry in append-only transcript order; pi-goal does not add a transient resume marker or synthesize a user message for plugin input. The wake source remains source-neutral: any native Pi turn may resume the goal, while provider, subagent, CI, and other event integrations stay outside this module. Each fallback message reports how many timeouts the current wait has taken and how long it has run, and offers a single-use `discardToken`. Passing that token back on the next `yield_goal` is the agent's own judgement that the recheck produced nothing worth keeping: pi-goal then rewinds the active branch to the position saved after the previous yield, so the recheck leaves the active transcript and provider context while staying in the session file on an abandoned branch. The extension never inspects what the recheck did; it only checks that the token is the one the current wake issued and that the wait has not run past that wake's timeout plus 300 seconds. A token that is missing, stale, reused or past its allowance simply yields as usual. Only a fallback wake issues a token, so a turn started by a real external event has no discard authority, and a real wake also ends the wait sequence so the next yield starts a fresh count. Reloading/restoring Pi clears the timer and converts a yielded goal to paused instead of silently resuming it; use `/goal resume` to continue. Session-tree navigation applies the same safety rule and cancels process-local work owned by the abandoned branch, so an old timeout cannot append to or wake the selected branch.

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
- `yield_goal({ reason, timeoutSeconds?, discardToken? })` tool: terminally return control while awaiting a future external prerequisite; the reason is normalized and bounded, a one-shot 270-second cache-heartbeat fallback rechecks by default, and `discardToken` discards the recheck that issued it
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
  -> yield_goal persists `yielded`, arms one 270-second cache-heartbeat fallback, and emits no immediate continuation
  -> a native Pi turn resumes first, or timeout expiry queues one recheck turn
  -> its persistent native wake entry remains the sole marker in later provider requests
  -> a recheck may yield with its discardToken, rewinding the active branch to the last yield position
  -> after a yield settles, a context over 100k tokens is compacted once
  -> pause when the user interrupts an active run, without queuing a wake-up message
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"` using schema version 3. Valid version-1 and version-2 records migrate losslessly and arrive with no open wait sequence. A wait sequence records when the current wait started and how many fallback timeouts it has taken, so that count survives a discard rewind. Unknown or malformed records fail safe without autonomous continuation. A yielded state records its bounded diagnostic reason and timestamp. Its fallback timer is process-local rather than persisted: native turns cancel it, and reload/session restore or session-tree navigation clears it and converts restored active authority to paused. Each timer is also bound to the branch entry where it was armed, so abandoned-branch expiry cannot mutate the selected branch. On a native wake, `turn_start` restores authority while the triggering native input remains the persistent transcript marker. Goal state follows the active session branch and does not require an external database.

## License

MIT
