import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { excerpt, formatDuration } from "../format.ts";
import type { Outcome, Source } from "./types.ts";

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
 * Runs `bash -c <command>` in its own process group, so stop and shutdown kill the whole tree.
 * Exit code 0 is success, anything else is failure.
 */
export function commandSource(command: string): Source {
	return {
		kind: "command",
		label: command.length > 60 ? `${command.slice(0, 59)}…` : command,
		start: (ctx) =>
			new Promise<Outcome>((resolve) => {
				const started = ctx.now();
				const recent: string[] = [];
				const remember = (line: string) => {
					recent.push(line);
					if (recent.length > TAIL_LINES * 3) recent.splice(0, recent.length - TAIL_LINES * 3);
				};
				const child = spawn("bash", ["-c", command], {
					cwd: ctx.cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PAGER: "cat", GH_PAGER: "cat", GIT_PAGER: "cat" },
				});
				let killTimer: NodeJS.Timeout | undefined;
				const onAbort = () => {
					if (child.pid === undefined || child.exitCode !== null) return;
					killGroup(child.pid, "SIGTERM");
					killTimer = setTimeout(() => child.pid !== undefined && killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
					killTimer.unref();
				};
				ctx.signal.addEventListener("abort", onAbort, { once: true });

				const out = createInterface({ input: child.stdout });
				const err = createInterface({ input: child.stderr });
				out.on("line", (line) => {
					remember(line);
					ctx.line(line, "stdout");
				});
				err.on("line", (line) => {
					remember(line);
					ctx.line(line, "stderr");
				});

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
					if (code === 0) return finish({ status: "success", summary: `exited 0 after ${took}` });
					const { lines, dropped } = excerpt(recent, TAIL_LINES);
					const how = code === null ? `killed by ${signal}` : `exited with code ${code}`;
					finish({
						status: "failure",
						summary: `${how} after ${took}`,
						context: "last output:",
						detail: lines,
						dropped,
					});
				});
			}),
	};
}
