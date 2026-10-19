import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { excerpt, formatDuration } from "../format.ts";
import type { Outcome, Source, SourceContext } from "./types.ts";

const KILL_GRACE_MS = 2000;
const TAIL_LINES = 30;

/** Kill a whole process group. Ignores groups that are already gone. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Where a command monitor gets its output from.
 * - `spawn`: run `bash -c <command>` in its own process group (what the `monitor` tool does).
 * - `child`: adopt a child process that is already running in this Pi process, e.g. handed over by
 *   a bash interceptor. Output printed before the hand-over is not seen. Needs piped stdout/stderr.
 * - `log`: follow a process started elsewhere through its log file and pid. Planned, not built yet.
 */
export type CommandOrigin =
	| { kind: "spawn"; command: string; reportOutput?: boolean }
	| { kind: "child"; child: ChildProcess; label: string; reportOutput?: boolean }
	| { kind: "log"; path: string; pid?: number; label: string };

const shortLabel = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

/**
 * Command source. Exit code 0 is success, anything else is failure.
 * Stop and shutdown kill the whole process group.
 */
export function commandSource(origin: string | CommandOrigin): Source {
	const from: CommandOrigin = typeof origin === "string" ? { kind: "spawn", command: origin } : origin;
	switch (from.kind) {
		case "spawn":
			return {
				kind: "command",
				label: shortLabel(from.command),
				start: (ctx) =>
					watchChild(
						spawn("bash", ["-c", from.command], {
							cwd: ctx.cwd,
							detached: true,
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, PAGER: "cat", GH_PAGER: "cat", GIT_PAGER: "cat" },
						}),
						ctx,
						from.reportOutput ?? false,
					),
			};
		case "child":
			return {
				kind: "command",
				label: shortLabel(from.label),
				start: (ctx) => watchChild(from.child, ctx, from.reportOutput ?? false),
			};
		case "log":
			throw new Error("Adopting a process through its log file is not supported yet.");
	}
}

/**
 * Follow a child process until it exits: stream its lines, kill its group on abort.
 * With `reportOutput` the success outcome carries the last lines too (timers, background commands).
 */
function watchChild(child: ChildProcess, ctx: SourceContext, reportOutput: boolean): Promise<Outcome> {
	return new Promise<Outcome>((resolve) => {
		const started = ctx.now();
		const recent: string[] = [];
		const remember = (line: string) => {
			recent.push(line);
			if (recent.length > TAIL_LINES * 3) recent.splice(0, recent.length - TAIL_LINES * 3);
		};
		let killTimer: NodeJS.Timeout | undefined;
		const onAbort = () => {
			if (child.pid === undefined || child.exitCode !== null) return;
			killGroup(child.pid, "SIGTERM");
			killTimer = setTimeout(() => child.pid !== undefined && killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
			killTimer.unref();
		};
		ctx.signal.addEventListener("abort", onAbort, { once: true });

		for (const [stream, name] of [
			[child.stdout, "stdout"],
			[child.stderr, "stderr"],
		] as const) {
			if (!stream) continue;
			createInterface({ input: stream }).on("line", (line) => {
				remember(line);
				ctx.line(line, name);
			});
		}

		let settled = false;
		const finish = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			ctx.signal.removeEventListener("abort", onAbort);
			if (killTimer) clearTimeout(killTimer);
			resolve(outcome);
		};
		child.on("error", (error) => finish({ status: "failure", summary: `could not start: ${error.message}` }));
		// Leftover background processes would keep the pipes open, so end the group with the shell.
		child.on("exit", () => child.pid !== undefined && killGroup(child.pid, "SIGTERM"));
		child.on("close", (code, signal) => {
			const took = formatDuration(ctx.now() - started);
			if (ctx.signal.aborted) return finish({ status: "stopped", summary: `stopped after ${took}` });
			const { lines, dropped } = excerpt(recent, TAIL_LINES);
			if (code === 0) {
				const output = reportOutput && lines.length ? { context: "output:", detail: lines, dropped } : {};
				return finish({ status: "success", summary: `exited 0 after ${took}`, ...output });
			}
			const how = code === null ? `killed by ${signal}` : `exited with code ${code}`;
			finish({ status: "failure", summary: `${how} after ${took}`, context: "last output:", detail: lines, dropped });
		});
	});
}
