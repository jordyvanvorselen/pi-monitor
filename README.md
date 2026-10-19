# pi-monitor

Watch long-running things in the background from [pi](https://github.com/earendil-works/pi-coding-agent): GitHub Actions runs, pull request checks, dev servers, builds, log files, URLs and processes. Pi keeps working or goes idle, and wakes up only when something worth knowing happens.

Without this extension a model waits with `sleep 60 && gh run view …` loops or a blocking `gh run watch`. That blocks the session and burns tokens on every poll. With pi-monitor the model starts a monitor, gets an answer in milliseconds and moves on. Progress goes to the screen, not to the model. The model hears about the end, and about failures right away.

## Quick start

Install the package:

```bash
pi install npm:@jordyvanvorselen/pi-monitor
```

Or install from a local checkout:

```bash
pi install /path/to/pi-monitor
```

Or try it for one run without installing:

```bash
pi -e npm:@jordyvanvorselen/pi-monitor
```

Then ask pi something like "push this and watch CI". The model calls:

```
monitor({ description: "CI for PR #42", gh_run: "latest" })
→ Started m1 "CI for PR #42" (gh run latest). You will be notified when it ends. Continue with other work.
```

A dock appears above the editor:

```
╭─ monitors ───────────────────────────────────────── 2 running · 1 failed · saved ~6.2k tok ─╮
│ ✗ e2e on staging exited with code 1 after 8m16s                                              │
│ ⠹ dev server  ▁▁▂▅▇▅▂▁  last: GET /api/users 200 in 12ms · 12s ago   pi is on it ↳  10m00s │
│ ⠹ CI #42  ●━━●━━◐┄┄○┄┄○  test ▸ Run unit tests                         ▰▰▰▱▱ ~1m  4m10s │
╰──────────────────────────────────────────────────────────── ctrl+shift+m view · /monitors ─╯
```

When a job fails, the model gets one short message with the tail of the failed log:

```
[monitor m1 "CI for PR #42"] job "test" failed
job "test" step "Run unit tests" failed:
  ✗ extension.test.ts > loads rules lazily
    Expected 2, received 3 (tests/extension.test.ts:88)
  log: /tmp/pi-monitor/<session>/m1.log
```

GitHub sources need the [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`.

## The tools

The model gets two tools. Pi adds two short guideline lines to the system prompt while the tools are active, telling the model to start a monitor instead of sleeping or polling in bash.

### `monitor`

Starts a watcher and returns at once. Give exactly one source.

| Parameter         | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `description`     | Short label for the UI and the messages, such as `"CI for PR #42"`.                               |
| `command`         | Shell command. Each stdout line is an event. Filter it yourself, e.g. `grep --line-buffered`.     |
| `gh_run`          | GitHub Actions run id, run URL, or `"latest"` for the newest run of `HEAD` on the current branch. |
| `gh_pr`           | Pull request number or URL. Watches all its checks.                                               |
| `file`            | File to tail. New lines only. Use with `match`.                                                   |
| `url`             | Wait until the URL answers 2xx.                                                                   |
| `pid`             | Wait until the process exits.                                                                     |
| `match`           | Regex. Only matching lines become events. Applies to stdout and stderr.                           |
| `wake`            | `"final"`, `"events"` or `"never"`. See below.                                                    |
| `timeout_minutes` | Default 30, at most 240.                                                                          |

### `monitor_stop`

Stops a monitor by id, such as `"m3"`, or `"all"`. A stop the model asks for does not wake it.

There is no read tool. Every message contains the log path, and the model reads it with `read`.

## When the model wakes up

| `wake`   | The model gets                                         | Default for                     |
| -------- | ------------------------------------------------------ | ------------------------------- |
| `final`  | One message when the watcher ends, plus every failure. | `gh_run`, `gh_pr`, `url`, `pid` |
| `events` | Every matching line, batched, plus the end.            | `command`, `file`               |
| `never`  | Nothing. The UI only.                                  |                                 |

- **Pi is idle:** the message starts a turn.
- **Pi is busy:** the message waits until the current run ends, as a follow-up.
- **A failure while Pi is busy:** the message steers the current run, so the model can stop work that depends on green CI.

Messages are short. Lines that arrive within half a second are batched, at most 20 lines per message, repeated lines are collapsed (`(×37) Waiting for job…`), and a message is capped at about 400 tokens. A monitor that wakes the model more than 10 times in a minute is paused: it keeps running and logging, but stops waking the model, and the model is told once to tighten `match` or use `wake: "final"`.

## What you see

- **Dock above the editor.** One row per monitor. GitHub rows show a job track (`●` done, `◐` running, `○` queued, `✗` failed), the current job and step, an ETA bar based on the median of the last ten green runs of the same workflow, and the elapsed time. The run name links to GitHub. Other rows show a sparkline of output per 10 seconds and the last line with its age. A source that stays silent for five minutes turns into a warning `quiet 5m`. `pi is on it ↳` shows while the model handles a message from that monitor.
- **Moments.** A finished row flashes green or red, collapses to `✓ CI #42 green in 6m02s` and disappears after 10 seconds. The terminal title shows `⠹ pi · CI 3/5`, then `✓ CI green` or `✗ CI failed`. A desktop notification goes out when a monitor ends, in terminals that support OSC 9, 99 or 777.
- **Savings meter.** The dock estimates the tokens saved compared to a polling loop: one poll per 30 seconds at about 200 tokens, minus what pi-monitor actually delivered. It ignores the cost of re-reading the context on every poll, so the real saving is higher.
- **Responsive.** Narrow terminals get compact rows like `⠹ CI #42 3/5 4m`. While pi is streaming the dock folds into one line: `◉ 3 monitors · CI #42 3/5 · e2e ✗`. More than four monitors show the three most important (failures first) and `+2 more`.
- **`ctrl+shift+m`** cycles the dock: card, one line, hidden. When hidden, the footer shows `◉ 2 monitors`. The key needs a terminal with the kitty keyboard protocol (kitty, Ghostty, WezTerm, recent iTerm2). Set `shortcut` to `"alt+m"` for other terminals.

### `/monitors`

Opens an overlay with all monitors of the session, a per-job timeline of the selected one and a live tail of its log.

| Key   | What it does                                                 |
| ----- | ------------------------------------------------------------ |
| `↑↓`  | Select a monitor                                             |
| enter | Full log view. Scroll with `↑↓`, PgUp and PgDn.              |
| `o`   | Open the run or pull request in the browser, or the log file |
| `s`   | Stop the selected monitor                                    |
| esc   | Close                                                        |

## Blocking waits

By default pi-monitor blocks three things in `bash` and points the model to `monitor` instead: `gh run watch`, `gh pr checks --watch` and `sleep` longer than 20 seconds. One blocked call costs about 50 tokens and usually teaches the model for the rest of the session. Set `blockBlockingWaits` to `false` to allow them.

## Sessions and logs

Every start and end is stored in the session as a custom entry. These entries never reach the model. After a resume or `/reload`, unfinished `gh_run` and `gh_pr` monitors restart with the same id. Commands, file tails, URL and pid watchers ended with the old session and show as "ended with the session".

Logs live in `<tmp>/pi-monitor/<session id>/<monitor id>.log`. Log directories older than seven days are removed at startup.

Shutting down pi stops every monitor and kills the process group of each command, including background children.

## Configuration

Add a `"monitor"` section to `~/.pi/agent/settings.json` for user-wide settings, or to `.pi/settings.json` in a project. Project settings win. Every key is optional.

```json
{
  "monitor": {
    "maxConcurrent": 5,
    "defaultTimeoutMinutes": 30,
    "blockBlockingWaits": true,
    "desktopNotifications": true,
    "reducedMotion": false,
    "dock": "card",
    "shortcut": "ctrl+shift+m"
  }
}
```

| Key                     | Default          | Meaning                                                                |
| ----------------------- | ---------------- | ---------------------------------------------------------------------- |
| `maxConcurrent`         | `5`              | Monitors that may run at the same time.                                |
| `defaultTimeoutMinutes` | `30`             | Timeout when the model gives none. At most 240.                        |
| `blockBlockingWaits`    | `true`           | Block `gh run watch`, `gh pr checks --watch` and long `sleep` in bash. |
| `desktopNotifications`  | `true`           | Send a terminal desktop notification when a monitor ends.              |
| `reducedMotion`         | `false`          | No spinner and no flash. Clocks still update once a second.            |
| `dock`                  | `"card"`         | How the dock starts: `"card"`, `"line"` or `"hidden"`.                 |
| `shortcut`              | `"ctrl+shift+m"` | Key that cycles the dock. Read at startup.                             |

## Modes

The dock, title, notifications and overlay only exist in the interactive terminal UI. In print, JSON and RPC modes the tools still work and messages still reach the model. `/monitors` prints a plain list there.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
```

Run `npm run lint:fix` to fix lint and formatting problems. Tests never call the real `gh`: sources get a `run()` function that the tests replace with recorded JSON fixtures.

## Versioning and releases

This package follows [semantic versioning](https://semver.org). Every pull request must raise the version in `package.json`. CI fails the pull request when the version is not higher than on `main`.

Pick the bump that matches the change:

| Change                                                | Command                                  | Example         |
| ----------------------------------------------------- | ---------------------------------------- | --------------- |
| Bug fix, docs, internal change                        | `npm version patch --no-git-tag-version` | `0.1.0 → 0.1.1` |
| New feature or setting that keeps old behaviour       | `npm version minor --no-git-tag-version` | `0.1.1 → 0.2.0` |
| Breaking change, such as a removed or renamed setting | `npm version major --no-git-tag-version` | `0.2.0 → 1.0.0` |

The command updates both `package.json` and `package-lock.json`. Commit both files.

When a pull request merges, GitHub Actions runs the checks again and publishes the new version to npm. It then creates a GitHub release tagged with the version number, such as `0.1.2`. GitHub generates the release notes from the merged pull requests.

Try it against a project without installing:

```bash
cd /path/to/project
pi -e /path/to/pi-monitor/src/index.ts
```

## License

MIT
