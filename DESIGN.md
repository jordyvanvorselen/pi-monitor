# pi-monitor design

pi-monitor lets Pi start a watcher, keep working or go idle, and wake up only when something worth knowing happens.
The user sees live progress in the footer and a widget. The model sees only the events that matter.

## Goals

- **Few tokens.** Progress goes to the UI, not the model. The model gets short, deduplicated events.
- **Feels instant.** The tool call returns in milliseconds. Events reach the user within about 1 second.
- **Never blocks.** No `sleep 60 && gh run view` loops and no blocking `gh run watch`.

## Inspiration: Claude Code's Monitor tool

Claude Code has a `Monitor` tool with a simple contract:

- The model gives a shell command and a short description.
- The command runs in the background.
- Each stdout line becomes an event for the model.
- The model is told to filter output itself, for example with `grep --line-buffered`.
- Lines that arrive close together are batched. A monitor that floods events is stopped.

pi-monitor keeps that contract and adds three things:

1. **Built-in sources** for common jobs, such as a GitHub Actions run. The model does not need to write a polling script.
2. **Wake levels.** Each event says whether it should wake the model or only update the UI.
3. **A real UI.** A widget, a footer status and a `/monitors` command.

## The model-facing surface

Two tools. Tool schemas are sent on every request, so the surface stays small.

### `monitor`

Starts a watcher and returns at once.

```ts
{
  description: string,          // "CI for PR #42". Shown in UI and events.
  // Exactly one source:
  command?: string,             // Generic: each stdout line is an event.
  gh_run?: string | number,     // Run id, URL, or "latest" for the current branch.
  gh_pr?: string | number,      // All checks on a PR.
  file?: string,                // Tail a file. Use with match.
  url?: string,                 // Wait until the URL answers 2xx.
  pid?: number,                 // Wait until the process exits.
  match?: string,               // Regex. Only matching lines become events.
  wake?: "final" | "events" | "never",  // Default "final" for built-in sources, "events" for command.
  timeout_minutes?: number,     // Default 30, max 240.
}
```

Result sent to the model, about 15 tokens:

```
Started m3 "CI for PR #42" (gh run 123456). You will be notified when it ends. Continue with other work.
```

### `monitor_stop`

```ts
{
  id: string;
} // "m3", or "all"
```

There is no list or read tool. The model reads the full log with the normal `read` tool. Each event message contains the log path.

## Event flow

```
source ──lines──▶ filter (match, dedupe) ──▶ batcher (~500 ms)
                                               │
                         ┌─────────────────────┼──────────────────────┐
                         ▼                     ▼                      ▼
                  log file (all)        widget + footer        model (wake events only)
```

### Wake levels

| Level    | The model gets                                               | Use for                        |
| -------- | ------------------------------------------------------------ | ------------------------------ |
| `final`  | One message when the watcher ends: success, failure, timeout | CI, deploys, builds            |
| `events` | Every filtered event, batched                                | Dev server errors, log tailing |
| `never`  | Nothing. The UI only.                                        | Things the user wants to watch |

`final` is the default for built-in sources. A 20-minute CI run then costs one message of about 80 tokens. A naive poll loop costs thousands.

One exception: a **failure wakes the model at once**, even under `final`. For a CI run this means the first failed job, not the end of the whole run.

### Delivery to the model

- **Pi is idle:** `pi.sendMessage(msg, { triggerTurn: true })`. Pi starts a turn and reacts.
- **Pi is busy:** `deliverAs: "followUp"`. The message arrives after the current run and does not interrupt.
- **Failure while busy:** `deliverAs: "steer"`. The model hears about it now, so it can stop work that depends on green CI.

Messages use `customType: "monitor"` with a custom renderer. The transcript shows one compact line, and the details expand on demand.

### Token budget per event

An event message is capped at about 400 tokens:

```
[monitor m3 "CI for PR #42"] FAILED after 6m12s
job "test" step "Run unit tests" failed:
  ✗ extension.test.ts > loads rules lazily
    Expected 2, received 3 (tests/extension.test.ts:88)
  … 214 more lines: /tmp/pi-monitor/m3.log
```

Rules:

- Strip ANSI codes, timestamps and GitHub log prefixes.
- Keep the last 30 lines of the failed step, then add the log path.
- Collapse repeated lines: `(×37) Waiting for job…`.
- Batches hold at most 20 lines. Extra lines are counted and saved to the log.

### Flood guard

If a monitor sends more than 10 wake events in 1 minute, pi-monitor pauses it. It wakes the model once with: "m2 is too noisy. Tighten `match` or use `wake: final`." Claude Code stops floods the same way.

## Built-in sources

Each source is a small TypeScript module with the same shape:

```ts
interface Source {
  start(signal: AbortSignal, emit: (e: MonitorEvent) => void): Promise<Outcome>;
}
type MonitorEvent = { text: string; level: "progress" | "notable" | "failure" };
type Outcome = { status: "success" | "failure" | "timeout" | "stopped"; summary: string };
```

### `gh_run`

- Polls `gh run view <id> --json status,conclusion,jobs` with backoff: every 5 seconds for the first minute, then 15, then 30.
- Compares each poll with the last one. It emits **changes only**: job started, job finished, run finished.
- On a failed job it runs `gh run view --job <id> --log-failed` and keeps the tail.
- `"latest"` resolves to the newest run for `git branch --show-current`. If the run does not exist yet, it waits up to 60 seconds. This covers "push, then monitor".

### `gh_pr`

- Polls `gh pr checks <pr> --json name,state,bucket,link`.
- Final state: all checks pass, or any check fails.
- A failure in a GitHub Actions check reuses the `gh_run` log fetch.

### `command`

- Spawns `bash -c` in its own process group, so stop and shutdown kill the whole tree.
- Reads stdout line by line. Stderr goes to the log only, unless `match` is set. Then both streams are filtered.
- Exit code 0 means success. Any other code means failure.

### `file`, `url`, `pid`

Small helpers: tail with `fs.watch`, poll an HTTP endpoint with backoff, and poll `process.kill(pid, 0)`.

## What the user sees

### Footer status

```
◉ 2 monitors · CI #42 ▸ test (3/5) · dev server ✓
```

Set with `ctx.ui.setStatus("monitor", …)`. It is cleared when no monitor runs.

### Widget above the editor

Shown only while a monitor runs. One line per monitor:

```
⠋ m3  CI for PR #42      test ▸ Run unit tests     4m10s
✓ m2  build docker image  done                      1m02s
✗ m1  e2e on staging      job "smoke" failed        8m40s   ctrl+o
```

A finished row stays for 10 seconds, then disappears.

### `/monitors` command

An overlay that lists running and recent monitors. Keys: `enter` opens the log, `s` stops, `w` cycles the wake level, `esc` closes.

### Desktop notification (optional)

When a monitor ends and the terminal is not focused, pi-monitor sends an OSC 9 or OSC 777 notification. The user can switch away from the terminal.

## Nudging the model away from blocking

- The tool description and `promptGuidelines` say: "To wait for CI, a deploy or a slow command, use `monitor`. Do not sleep or poll in bash."
- Optional guard, on by default: a `tool_call` handler blocks `gh run watch`, `gh pr checks --watch` and `sleep` over 20 seconds in `bash`. The reason it returns points to the matching `monitor` call. One blocked call teaches the model in about 50 tokens.

## Lifecycle and state

- No timers or processes start in the factory. Monitors start from the tool call.
- `session_shutdown` aborts every monitor and kills its process group. Cleanup is idempotent.
- Every start and end is recorded with `pi.appendEntry("monitor", …)`. This data stays out of the model context.
- On `session_start` after a resume, pi-monitor reads the branch entries:
  - It restarts `gh_run` and `gh_pr` watchers that had not finished. They hold no state beyond the id.
  - It marks `command` watchers as "ended with the session" in the UI.
- Logs live in `os.tmpdir()/pi-monitor/<session>/<id>.log`. They are removed after 7 days.

## Settings

Read from `.pi/settings.json` under `"monitor"`:

```json
{
  "monitor": {
    "maxConcurrent": 5,
    "defaultTimeoutMinutes": 30,
    "blockBlockingWaits": true,
    "desktopNotifications": true
  }
}
```

## Code layout

```
src/
  index.ts          register tools, command, events
  registry.ts       running monitors, ids, limits, stop/stopAll
  delivery.ts       wake level, batching, flood guard, sendMessage options
  format.ts         ANSI strip, dedupe, truncate, event text
  sources/
    command.ts
    gh-run.ts
    gh-pr.ts
    file.ts url.ts pid.ts
  ui/
    widget.ts status.ts overlay.ts renderer.ts
  guard.ts          blocks blocking waits in bash
  settings.ts
tests/
  format.test.ts      truncation and dedupe
  delivery.test.ts    wake levels, followUp vs steer, flood guard (fake clock)
  gh-run.test.ts      state diffing against recorded gh JSON fixtures
  command.test.ts     real child process: lines, exit code, process group kill
  guard.test.ts
```

Sources get a `run(cmd)` function that tests replace, so `gh` never runs in CI.

## Build order

1. `command` source, `monitor` and `monitor_stop` tools, delivery with all three wake levels, the log file. This is enough to be useful.
2. Footer status, widget and message renderer.
3. `gh_run` and `gh_pr` sources.
4. Guard for blocking waits, `/monitors` overlay, resume after restart.
5. `file`, `url` and `pid` sources, desktop notifications.
