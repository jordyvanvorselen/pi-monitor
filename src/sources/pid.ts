import { formatDuration } from "../format.ts";
import type { Source } from "./types.ts";

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Waits until a process exits. The exit code is not available for processes we did not start. */
export function pidSource(pid: number, alive: (pid: number) => boolean = processAlive): Source {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid must be a positive integer. Got ${pid}.`);
	return {
		kind: "pid",
		label: `pid ${pid}`,
		async start(ctx) {
			const started = ctx.now();
			if (!alive(pid)) return { status: "failure", summary: `no process ${pid} is running` };
			while (!ctx.signal.aborted) {
				await ctx.sleep(1_000);
				if (ctx.signal.aborted) break;
				if (!alive(pid))
					return { status: "success", summary: `process ${pid} exited after ${formatDuration(ctx.now() - started)}` };
			}
			return { status: "stopped", summary: "stopped" };
		},
	};
}
