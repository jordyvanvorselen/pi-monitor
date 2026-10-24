# pi-monitor design

pi-monitor lets Pi start a watcher, keep working or go idle, and wake up only when something worth knowing happens.
The user sees live progress in a dock above the editor. The model sees only the events that matter.

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
3. **A real UI.** A dock above the editor and a `/monitors` overlay.

## The model-facing surface

Two tools. Tool schemas are sent on every request, so the surface stays small.

### `monitor`

Starts a watcher and returns at once.

```ts
{
  description: string,          // "CI for PR #42". Shown in UI and events.
  // Exactly one source:
  command?: string,             // Generic: each stdout line is an event.
  gh_run?: string | number,     // Run id, URL, "latest" (newest run of HEAD) or "next" (next run to start).
  branch?: string,              // gh_run "latest"/"next": branch instead of the current one.
  workflow?: string,            // gh_run "latest"/"next": only this workflow.
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

There is no list or read tool. The model reads the full log with the normal `read` tool. Messages for failures and cut output contain the log path.

Every stop has a reason, stored in the end entry and shown in the summary: "stopped by the model" (`monitor_stop`), "stopped by the user" (`/monitors`, or an aborted bash call the safety net was running), "stopped at session shutdown", or "timed out". A stop by the user is queued for the model with `deliverAs: "nextTurn"`: it hears about it with its next turn, without being woken. A stop by the model stays silent.

## Event flow

```
source ──lines──▶ filter (match, dedupe) ──▶ batcher (~500 ms)
                                               │
                         ┌─────────────────────┼──────────────────────┐
                         ▼                     ▼                      ▼
                  log file (all)        dock + title           model (wake events only)
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
[monitor m3 "CI for PR #42"] failed: CI #42 failure after 6m12s: test
job "test" step "Run unit tests" failed:
  ✗ extension.test.ts > loads rules lazily
    Expected 2, received 3 (tests/extension.test.ts:88)
log (214 more lines): /tmp/pi-monitor/m3.log
```

A success that fits stays short and has no log path:

```
[monitor m1 "sleep 45 && echo done"] done: exited 0 after 45s
output:
  done
```

Rules:

- Strip ANSI codes, timestamps and GitHub log prefixes.
- Short status words: `done`, `failed`, `timed out`. The transcript's collapsed line shows the status as a glyph and the summary without the status word.
- Keep the last 30 lines of the failed step.
- The log path goes on its own line after the body, and only for failures, timeouts and cut output. It stays absolute so `read` can open it.
- Command monitors with `wake: "final"` (and intercepted commands) put their last output in the success message too.
- Collapse repeated lines: `(×37) Waiting for job…`.
- Batches hold at most 20 lines. Extra lines are counted and saved to the log.

### Flood guard

If a monitor sends more than 10 wake events in 1 minute, pi-monitor pauses it. It wakes the model once with: "m2 is too noisy. Tighten `match` or use `wake: final`." Claude Code stops floods the same way.

## Built-in sources

Each source is a small TypeScript module with the same shape:

```ts
interface Source {
  kind: SourceKind;
  label: string; // "gh run 123456"
  start(ctx: SourceContext): Promise<Outcome>;
}
interface SourceContext {
  signal: AbortSignal;
  cwd: string;
  run: Run; // execFile without a shell; tests replace it, so gh never runs in CI
  now(): number;
  sleep(ms: number): Promise<void>; // resolves early on stop
  emit(e: MonitorEvent): void; // structured event; delivery decides if it wakes the model
  line(text: string, stream?: "stdout" | "stderr"): void; // raw output; log + UI, `match` makes it an event
  update(p: Partial<Progress>): void; // UI only: title, url, jobs, ETA
}
type MonitorEvent = { text: string; level: "progress" | "notable" | "failure"; context?: string; detail?: string[] };
type Outcome = { status: "success" | "failure" | "timeout" | "stopped"; summary: string; detail?: string[] };
```

Other modules start monitors with `startMonitor(registry, spec)` from `registry.ts`. It returns the id and the "Started m3 …" text. The `monitor` tool is a thin wrapper around it.

### `gh_run`

- Polls `gh run view <id> --json status,conclusion,jobs,…` with backoff: every 5 seconds for the first minute, then 15, then 30 after five minutes.
- Compares each poll with the last one. It emits **changes only**: job started, job finished, run finished.
- On a failed job it runs `gh run view --job <id> --log-failed` and keeps the tail.
- `"latest"` resolves to the newest run for `git rev-parse HEAD` on `git branch --show-current` (or `branch`). If the run does not exist yet, it waits up to 60 seconds, then falls back to the newest run on the branch. This covers "push, then monitor". A run that already finished returns its result at once.
- `"next"` waits for the first run on the branch created after the monitor started (5 s of clock skew allowed), polling `gh run list --branch <b> [--workflow <w>]` with the usual backoff, then watches it like any run. Use it for "watch CI" when nothing runs yet. The monitor timeout ends the wait.
- Once per run it asks `gh run list --workflow <id> --status success --limit 10` for the median duration. The UI shows it as an ETA bar.
- Auth errors and a missing `gh` end the monitor at once. Other gh errors are retried; five in a row end it.

### `gh_pr`

- Polls `gh pr checks <pr> --json name,state,bucket,link,startedAt,completedAt,workflow`.
- A failed check wakes the model at once. The monitor keeps running until no check is pending, then ends with the totals. "No checks reported" right after a push is treated as "keep waiting".
- A failure in a GitHub Actions check reuses the `gh_run` log fetch.

### `command`

- Spawns `bash -c` in its own process group, so stop and shutdown kill the whole tree.
- Reads stdout line by line. Stderr goes to the log only, unless `match` is set. Then both streams are filtered.
- Exit code 0 means success. Any other code means failure. The failure message carries the last 30 lines.
- The source takes a `CommandOrigin`: `spawn` (the tool), `child` (adopt a child process that already runs, for a future bash interceptor) or `log` (follow a log file plus pid; declared, not built yet).

### `file`, `url`, `pid`

Small helpers: tail a file every 500 ms (like `tail -F`: new lines only, survives truncation, waits for the file), poll an HTTP endpoint with backoff (2 s, 5 s, 10 s), and poll `process.kill(pid, 0)` every second.

## UI

Everything the user sees outside the transcript lives in `src/ui/`. Colors come from `theme.fg(...)` at render time, widths are measured with `visibleWidth`/`truncateToWidth` from pi-tui, and rendered lines are cached per width until something changes. Only TUI mode (`ctx.mode === "tui"`) gets UI. The tools work headless.

### Dock above the editor

A rounded card, shown only while there is something to show:

```
╭─ ◉ monitors ──────────────────────────────────────────── 3 running · 1 failed · saved ~6.2k tok ─╮
│ ⠸ e2e #17     ●━━✗┄┄○  checkout ✗ Run cart.spec.ts             pi is on it ↳  ██▌    ~2m   2m10s │
│ ⠸ dev server  ▁▁╱╲▁▂▂▁▁▁╱╲  last: GET /api/users 200 in 12ms · 1s ago                     10m00s │
│ ⠸ CI #42      ●━━●━━◐┄┄○  test ▸ Run unit tests                               ████▋  ~1m   4m43s │
╰─────────────────────────────────────────────────────────────────────────── ctrl+shift+m details ─╯
```

- Title "monitors" in the top border, summary on the right: running, failed and the token savings meter.
- Each row starts with a spinner (red when a job already failed, `‖` when paused) and the name. For GitHub sources the name is an OSC 8 link to the run or PR.
- `gh_run`/`gh_pr` rows: job track (`●` done, `◐` running, `○` queued, `✗` failed, `◌` skipped; solid links after finished jobs), current job `▸` step, ETA bar from the median of the last ten green runs, elapsed time. Long tracks shrink, very long ones become `12/30`.
- `command`, `file`, `url`, `pid` rows: heartbeat (ECG: solid `▁` baseline, a full-height `╱╲` spike and a low `▂▂` bump per arriving line, a smaller `▂▃▂` blip for lines in a burst, scrolling 4 cells a second, bright head and a tail that fades only near its end). Box and block characters, because terminals draw them edge to edge, where braille dots read as noise, then `last: <line> · 12s ago`. The age dims after a minute and turns into a warning `quiet 5m` after five minutes.
- `pi is on it ↳` while the model handles a message from that monitor: from the message (or the turn it triggers) until `agent_settled`.
- Failures first, then running monitors (oldest first), then finished ones. More than four rows: the three most important plus `+2 more · /monitors`.

### Colour (dock v2)

With Pi's theme the dock is drawn cell by cell (`src/ui/dock-rich.ts`, `cells.ts`, `effects.ts`, `look.ts`). Rounded border in a gradient with a light sweep every 6 s, pulsing header dot and shimmering `monitors` title, gradient job track with a turning running node and a glint, eighth-block ETA bar with a shimmer, `pi is on it ↳` shimmer.

Colour roles come from the theme (`look.ts`, `ROLE_TOKENS`). The launch video palette (teal `#3CF2C8`, indigo `#7C8CFF`, red `#FF5F6D`, gold `#FFD66B`) maps to tokens:

| Role             | Theme token                          | Used for                                                     |
| ---------------- | ------------------------------------ | ------------------------------------------------------------ |
| `success` (teal) | `success`                            | spinner, done jobs, ✓, green flash, gradient start           |
| `link` (indigo)  | `mdLink`, else `border`/`accent`     | gradient end of title, track, heartbeat tail, shimmer        |
| `border`         | `border`, else `mdLink`/`accent`     | gradient end of the card border                              |
| `error` (red)    | `error`                              | failed jobs, ✗, failing spinner, red glow                    |
| `warning` (gold) | `warning`                            | running job node, ETA start, overtime, countdown, `quiet 5m` |
| text tones       | `text`, `muted`, `dim`, `toolOutput` | names, labels, ages, last line                               |

- Theme colours given as ANSI indexes 0-15 resolve through the palette the terminal reports. A role without a token uses the video palette (dark) or a deeper version of it (light). Accents are pushed toward black or white until they reach a 3:1 contrast with the background.
- Gradients, glows and fades blend into the terminal's real background (asked once with `tui.queryTerminalColors`; until it answers, the theme's appearance decides between a dark and a white guess). The "highlight" for hot tips, glints, the shimmer and the border sweep is white on dark backgrounds and a near-black text colour on light ones, so nothing turns white on white. Light backgrounds get 60% glow strength, a stronger border and a stronger heartbeat tail.
- Everything is a pure function of the clock, so frames are testable. The controller ticks every 66 ms (about 15 fps) while something is visible and not `reducedMotion`, and stops when nothing is.
- Failing runs breathe red. A green run flashes.
- 256-colour terminals get the nearest colours (Pi's `foregroundAnsi`) and no background tints. Only themes without `getColorMode` (not Pi's theme) use the plain renderer in `dock.ts`.
- `reducedMotion`: same colours, no spinner, shimmer, sweep, glow, flash or dissolve. Clocks and the heartbeat move once a second.

### Moments

- A finished row keeps its last running layout for 0.3 s (`✓`, all jobs passed, ETA `done`), dissolves right to left into `✓ CI #42 green in 6m02s` over 0.7 s, shows it bold in the result colour, settles to muted and disappears after 10 s. Without colour it flashes for 1.5 s.
- Terminal title via `ctx.ui.setTitle`: `⠹ pi · CI 3/5` while running, `✓ CI green` or `✗ CI failed` for 10 s after the end, then Pi's own `π - <session> - <dir>`.
- Desktop notification on success, failure and timeout: OSC 99 (kitty), OSC 9 (iTerm2) or OSC 777 (others). Setting `desktopNotifications`.
- Token savings meter: a polling loop would cost one call per full 30 s of watching at about 200 tokens. Savings are that minus the tokens pi-monitor delivered, summed over monitors that may wake the model. It ignores the cost of re-reading the growing context, so the real saving is larger. See `src/savings.ts`.

### Responsive

- Wide (≥ 88 columns inside the card): everything.
- Medium (56–87): no heartbeat and no ETA.
- Narrow (< 56): `⠹ CI #42 2/5 4m`.
- The dock never folds or hides itself: it shows the full card whenever monitors exist, also while the agent works, and disappears only when there are none. A real-session test showed a folded one-line dock reads as a broken UI. Only a terminal too narrow for a card (< 24 columns) gets one line.
- There is no footer status; the dock already says it all.
- `ctrl+shift+m` (setting `shortcut`) opens `/monitors`; pressing it again or `esc` closes it. The overlay also checks the key itself, in case it keeps the focus. It does not clash with Pi's built-in bindings. The key needs a terminal with the kitty keyboard protocol; `alt+m` is a good alternative for others.

### Probation rows

A bash command the safety net runs shows at once as `⏳ yarn dev  ▁╱╲▁▂▂  last: … · 2s ago   background in 9s`, with a countdown instead of the clock. It counts as running in the summary. If it ends in time, bash gets its result and the row disappears quietly: no flash, no finished row, no title, no notification, no savings. If it moves to the background, it becomes a normal running row.

### `/monitors` overlay

Running and recent monitors, a per-job Gantt timeline of the selected one (activity sparkline for non-GitHub sources) and a live tail of its log. Keys: `↑↓` select, `enter` full log view (scroll with `↑↓`/PgUp/PgDn), `o` opens the run or PR in the browser (the log file when there is no URL), `s` stops (the model hears about it with its next turn, through `deliverAs: "nextTurn"`, without being woken), `esc` closes. Outside TUI mode `/monitors` prints a plain list.

### Transcript

Monitor messages use `customType: "monitor"` with a renderer. Collapsed: `✗ monitor m3 CI for PR #42 · failed: …`. Expanded: the exact text the model got.

### Performance

One timer drives everything. It ticks every 120 ms while a monitor runs (spinner), every 250 ms while finished rows fade out, and stops when nothing is visible and on `session_shutdown`. `reducedMotion` turns off spinner and flash and ticks once a second. During output bursts redraws wait for the next tick instead of following every line.

## Herdr

[Herdr](https://herdr.dev) runs agents in panes and shows them in a sidebar. Inside Herdr, pi-monitor reports monitors to that sidebar (`src/herdr/`).

- **Detection:** `HERDR_ENV=1` plus `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`, TUI mode, and the setting `herdr: "on"`. Print, JSON and RPC modes never talk to Herdr.
- **Socket:** one JSON line out, one JSON line back, a new Unix socket connection per request, no CLI spawns (`client.ts`). Requests run one after the other. A request that fails resolves to undefined, is logged to `<tmp>/pi-monitor/herdr.log` and makes the client skip requests for 1 s, 2 s, 4 s … up to 60 s. Nothing throws into pi or the dock.
- **Token:** `pane.report_metadata` with `$mon` for the pi pane only (`tokens.ts`, `sidebar.ts`). No space token: Herdr keeps one value per key per workspace and the last report wins (checked live with two sources), so two pi sessions in one space would overwrite each other. Agent rows are per pane, so they cannot clash. One fixed source, `pi-monitor`, because Herdr keeps at most 32 sources per pane for its lifetime. No `seq`: requests are serial, and a new pi in the same pane would start below the old sequence and be ignored. The value carries a 60 s TTL, refreshed every 30 s while it shows, so a crashed pi leaves nothing behind. When nothing is left, it is cleared with `null`.
- **`$mon`:** the most important visible monitor: failures, running GitHub runs, a fresh success (for the dock's 10 s), other running monitors, stopped ones. Text reuses the dock helpers (`displayName`, `finishedText`, `jobCounts`): `◐ CI #42 ▰▰▰▱▱ 3/5 · 4m`. A running GitHub run with `progress.etaMs` (the dock's estimate) gets a 5-cell text bar: `floor(elapsed / eta × 5)` cells, at most 4 until the run ends, so the token changes only when a whole cell fills and the throttle stays quiet. No ETA, other kinds, failure and finish moments: no bar. `▰▱` have a neutral East Asian width (unlike `■□`), and a live check in Herdr's sidebar showed them one column wide with the border in place. The token is at most 80 characters: running rows shorten the name and keep the glyph, bar, counts and ` +N`; other rows are cut at the end. Each state starts with its own glyph (`◐ ⏳ ‖ ✗ ◔ ✓ ■ ◌`) so config rules can colour it by `starts_with`.
- **Rate:** every token change makes Herdr resend the sidebar to SSH clients ([herdr#4428](https://github.com/herdrdev/herdr/issues/4428)). So at most one report per second, only on change, no spinner, and clocks in whole minutes. A 1 s timer runs only while something is visible or a value still needs clearing.
- **Notifications:** with the integration on, `UiController.ended` routes its notification to `notification.show` instead of the OSC escape. Herdr does not forward OSC notifications from panes, and its toasts know which tab you look at, so this gives exactly one notification. Sound `done` for success, `request` for failure and timeout. `desktopNotifications: false` turns it off. When Herdr cannot be reached, the OSC notification goes out instead. A `disabled` reply (toasts off in Herdr) is respected.
- **Blocked mark** (`attention.ts`, setting `herdrAttention`, off by default): Herdr's pi integration listens for `pi.events` `herdr:blocked` `{ active, label }` and counts them. A failure or timeout that the model does not pick up within 2 s emits `active: true` with `CI #42 failed`. Exactly one `active: false` follows when the model handles that monitor, a monitor with the same name or description starts (a re-run), the user types (`input` event from the interactive editor), the integration turns off or the session ends. The grace time avoids a blocked flash when an idle pi starts on the failure at once. pi-monitor never sends `pane.report_agent` itself.
- **`/monitors herdr`** (`integration.ts`, `config.ts`): writes `herdr: "on"` to the user settings with Pi's lock convention (a `settings.json.lock` directory) and an atomic rename, then edits Herdr's config. Herdr only renders custom tokens a row names, so the config needs a `$mon` row. The edit is text-based to keep comments and layout: parse with `smol-toml`, find the `rows` statement of `[ui.sidebar.agents]` (or `rows_by_agent.pi` when the user has one), and replace only that value with the user's rows (Herdr's defaults when there are none) minus any old `$mon` row, plus ours. Test builds also added a `$ci` row to `[ui.sidebar.spaces]`; setup takes it out again: the user's other space rows stay, a `rows` that only holds Herdr's defaults is removed, and so is the table when nothing else is in it. A missing table is appended. The result is parsed again and must contain exactly what we meant, else nothing is written and the user gets the lines to add by hand. Re-running gives the same text (idempotent). Before writing, `herdr config check` runs on a candidate file next to the config; then a timestamped backup is made, the file is replaced atomically and `server.reload_config` applies it. A reload with diagnostics puts the backup back. Toast delivery is not touched: Herdr shows toasts by default, and an explicit `"off"` is the user's choice, so the command only mentions it.
- **`off`** stores `herdr: "off"`, clears the token and takes back blocked marks. The config row stays; an empty token hides its row, so it costs nothing.
- **No terminal progress sequence (OSC 9;4).** Herdr 0.9.3 keeps the last OSC 9;4 payload of a pane only as input for agent-state detection (`src/pane/osc.rs`, the `osc_progress` region of detection manifests). Nothing in the source draws it, in the sidebar or the tabs, or passes it on to the outer terminal; the client draws pane content itself. A live test with `printf '\e]9;4;1;50\a'` in a throwaway session changed nothing on screen. Sending it would show nothing and could feed Herdr's state detection, so pi-monitor does not.
- **Startup note:** at `session_start` with reason `startup`, inside Herdr, in TUI mode and with `herdr` unset, one `ctx.ui.notify(…, "warning")` line, once per process, like other extensions' startup notes (pi-bare-worktrees). Pi draws warnings in yellow with a `Warning: ` prefix; `info` is dim grey and was easy to miss. `notify` takes plain text, so the commands are not highlighted separately.

## The bash interceptor

The model does not have to know about `monitor` to avoid blocking. A `tool_call` handler looks at every `bash` call and moves waits and long-running commands to the background. A `tool_call` handler can only change the input or block, so it changes the command into something harmless that prints the answer. The model gets a normal, successful result.

```
bash tool_call
   │
   ├─ print/JSON mode, or PI_MONITOR_INTERCEPT=0 ─────────────▶ run as is
   │
   ├─ known wait? gh run watch · gh pr checks --watch
   │             sleep N && X (N > 20) · tail -f F [| grep P] ─▶ start monitor, command → printf "Running in background as m3 …"
   │
   ├─ obviously short? (ls, cat, rg, git status, …) ──────────▶ run as is
   │
   └─ suspect: classifier (or keyword guess without one)
         ├─ short ───────────────────────────────────────────▶ run as is
         ├─ background ──────────────────────────────────────▶ command monitor (wake final), command → printf
         └─ unsure ── safety net: pi-monitor runs the command itself, bash runs a wait script
                         ├─ ends within 30 s ─▶ wait script prints the output, exits with the real code
                         └─ still running ────▶ "Still running after 30s. Moved to background as m4 …", exit 0;
                                                 the monitor wakes the model when the command ends
```

- **Print and JSON mode** end after the run, so nothing would receive a later message. The interceptor only acts when `ctx.hasUI` is true (TUI and RPC). `PI_MONITOR_INTERCEPT=0` turns it off.
- **Patterns** (`src/intercept/patterns.ts`) use a small shell lexer that gives up on subshells, command substitution, here-docs, braces, variables and globs. Anything with redirects or chains it does not fully understand is not rewritten.
- **Obviously short**: every command in the line starts with a known quick command (`ls`, `cat`, `rg`, `jq`, `git status/diff/log/show/…`, …). Test runners are not on the list; they can take long.
- **Classifier**: `ctx.modelRegistry.getAvailableOfType("classifier")`, the pinned `classifier` setting or the first one. One choice question (`background`, `short`, `unsure`) about `{ command, cwd, assistant_message }`, with a 1.5 s timeout through the abort signal. `classify()` never throws; a non-`stop` stop reason, a timeout or a confidence below 0.6 means `unsure`. Answers are cached per exact command for the session.
- **Keyword guess** without a classifier: dev servers, watchers, `--follow`, deploys, `docker compose up` and similar mean `unsure`; everything else runs as is.
- **Safety net** (`src/intercept/safety-net.ts`): spawns the command with Pi's `shellPath` and `shellCommandPrefix` in its own process group and adopts the child as a command monitor on probation (see Probation rows). Output goes to the monitor log and to a capture file. A status file holds `exit:<code>`, `bg` or `timeout`; the wait script polls it every 200 ms. A bash `timeout` shorter than the threshold is honoured: the command is killed and the script exits 124. A longer one bounds the backgrounded monitor. For known waits the bash `timeout` also becomes the monitor timeout, never below a timer's sleep plus 15 s. If the bash call ends before a decision (abort), the command is stopped too.
- **Transcript**: Pi passes `tool_call` handlers a copy of the arguments and keeps the original tool call in the transcript, so the model and the user both see the command the model wrote; only what runs changes. Therefore the result text alone must say what happened: it names the monitor and says it runs in the background. `pi.registerToolRenderer` only adds a `→ monitor m3` line under the result while that monitor runs.
- **Fail open**: any error in the interceptor leaves the command untouched and is logged to `<tmp>/pi-monitor/interceptor.log`.
- The tool's `promptSnippet` and `promptGuidelines` tell the model it may run long commands in bash and that `monitor` gives explicit control. Pi adds these lines to the system prompt only while the tool is active, as a transcript delta. No `before_agent_start` prompt edits.

## Lifecycle and state

- No timers or processes start in the factory. Monitors start from the tool call.
- `session_shutdown` writes an end entry with reason `shutdown` for every running monitor, then aborts them and kills their process groups. Cleanup is idempotent.
- Every start, end and resolved `"latest"`/`"next"` run is recorded with `pi.appendEntry("monitor-state", …)`. This data stays out of the model context.
- On `session_start` after a resume, pi-monitor reads the branch entries:
  - It restarts `gh_run` and `gh_pr` watchers that had not finished (or were stopped by a shutdown), with the same id. They hold no state beyond the target.
  - It marks other watchers (`command`, `file`, `url`, `pid`) as "ended with the session" in the UI.
- Logs live in `os.tmpdir()/pi-monitor/<session>/<id>.log`. They are removed after 7 days.

## Settings

Read from `~/.pi/agent/settings.json` and `.pi/settings.json` under `"monitor"`. The project file wins.

```json
{
  "monitor": {
    "maxConcurrent": 5,
    "defaultTimeoutMinutes": 30,
    "backgroundAfterSeconds": 30,
    "classifier": "typesafe/jev-latest",
    "desktopNotifications": true,
    "reducedMotion": false,
    "shortcut": "ctrl+shift+m",
    "herdr": "on",
    "herdrAttention": false
  }
}
```

`herdr` is unset until the user runs `/monitors herdr` or `/monitors herdr off`; the command writes it to the user file.

## Code layout

```
src/
  index.ts          register tools, command, shortcut, renderer, events
  tools.ts          tool schemas, argument checks, spec from tool input
  registry.ts       running monitors, ids, limits, stop/stopAll, startMonitor()
  delivery.ts       wake level, batching, flood guard, sendMessage options
  format.ts         ANSI strip, dedupe, truncate, event text
  log.ts            log files and cleanup
  resume.ts         what to restart after a resume
  savings.ts        token savings estimate
  exec.ts           default run() and abortable sleep
  notify.ts         desktop notification, open in browser
  intercept/
    index.ts        the bash interceptor flow
    shell.ts        small shell lexer
    patterns.ts     known blocking waits
    triage.ts       skip list, keyword guess, classifier
    safety-net.ts   run unsure commands, hand back or move to the background
    rewrite.ts      printf and wait scripts
  settings.ts       read settings, write one user setting under Pi's lock
  herdr/
    client.ts       detection, config path, socket client with backoff
    tokens.ts       $mon text
    sidebar.ts      report tokens: on change, once a second, TTL refresh, clear
    attention.ts    herdr:blocked marks for failures nobody handles
    config.ts       merge the rows into Herdr's config.toml
    integration.ts  wiring, toasts, /monitors herdr, startup note
  sources/
    types.ts index.ts command.ts gh.ts gh-run.ts gh-pr.ts file.ts url.ts pid.ts
  ui/
    glyphs.ts       spinner, job track, ETA bar, sparkline (plain dock, overlay)
    dock.ts         dock rendering and component
    dock-rich.ts    dock v2: colour rows, card, glows, dissolve
    effects.ts      heartbeat, gradient track, ETA bar, border sweep
    cells.ts        cell lines, truncation, dissolve, ANSI encoding
    color.ts        colour math, contrast and palette
    look.ts         theme tokens → colour roles, terminal background
    title.ts        terminal title
    controller.ts   widget, status, title, notifications, timer
    overlay.ts      /monitors
    renderer.ts     transcript messages
    bash-renderer.ts "→ monitor m3" under intercepted bash results
scripts/
  record-dock.ts    renders the real dock for docs/dock.gif (agg per frame, ffmpeg joins)
  dock-story.ts     the scripted fake monitors of that recording
  pi-theme.ts       Pi's built-in themes, for tests and the recording
tests/
  format, delivery (fake clock), gh (JSON fixtures), command (real processes, group kill),
  sources (file, url, pid), patterns, triage (fake classifier), safety net (real processes), intercept, registry, resume, dock (several widths, stub theme), ui, extension,
  herdr-client (fake Unix socket server), herdr-sidebar (token, throttle, TTL, blocked mark), herdr-config (merge, old $ci removal, backup), herdr (command, note, toasts)
```

## Build order

1. `command` source, `monitor` and `monitor_stop` tools, delivery with all three wake levels, the log file. This is enough to be useful.
2. Footer status, widget and message renderer.
3. `gh_run` and `gh_pr` sources.
4. Guard for blocking waits, `/monitors` overlay, resume after restart.
5. `file`, `url` and `pid` sources, desktop notifications.
