import { execFile } from "node:child_process";
import type { Run } from "./sources/types.ts";

/** Default `Run`: execFile without a shell. A non-zero exit code is a result, not an error. */
export const defaultRun: Run = (command, args, options = {}) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd: options.cwd, signal: options.signal, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const err = error as (Error & { code?: number | string }) | null;
				const code = !err ? 0 : typeof err.code === "number" ? err.code : 127;
				resolve({ stdout: stdout ?? "", stderr: stderr || (err && !stdout ? err.message : "") || "", code });
			},
		);
	});

/** Sleep that resolves early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
