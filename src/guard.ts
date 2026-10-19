/** Longest `sleep` that is still fine in bash. */
export const MAX_SLEEP_SECONDS = 20;

const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Total seconds of the longest `sleep` in a command line, e.g. `sleep 1m 30` → 90. */
export function longestSleep(command: string): number {
	let longest = 0;
	for (const match of command.matchAll(/(?:^|[\s;&|(`])sleep((?:\s+\d+(?:\.\d+)?[smhd]?)+)(?=\s*(?:$|[;&|)`\n]))/g)) {
		let total = 0;
		for (const part of match[1]!.trim().split(/\s+/)) {
			const unit = /[smhd]$/.test(part) ? part.slice(-1) : "";
			total += Number.parseFloat(part) * UNIT_SECONDS[unit]!;
		}
		longest = Math.max(longest, total);
	}
	return longest;
}

/**
 * Why a bash command should not run, or undefined when it is fine.
 * Blocks `gh run watch`, `gh pr checks --watch` and `sleep` over 20 seconds, and points to `monitor`.
 */
export function blockingWaitReason(command: string): string | undefined {
	const runWatch = /\bgh\s+run\s+watch\b(?:\s+(\d+))?/.exec(command);
	if (runWatch) {
		const id = runWatch[1] ?? "latest";
		return (
			"Blocked: `gh run watch` blocks the session. Start a monitor instead and keep working: " +
			`monitor({ description: "CI", gh_run: "${id}" }). It reports back when a job fails or the run ends.`
		);
	}
	const prChecks = /\bgh\s+pr\s+checks\b([^;&|\n]*)/.exec(command);
	if (prChecks && /--watch\b/.test(prChecks[1]!)) {
		const pr = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(prChecks[1]!)?.[1] ?? "<number>";
		return (
			"Blocked: `gh pr checks --watch` blocks the session. Start a monitor instead and keep working: " +
			`monitor({ description: "PR checks", gh_pr: "${pr}" }). It reports back when a check fails or all pass.`
		);
	}
	const seconds = longestSleep(command);
	if (seconds > MAX_SLEEP_SECONDS) {
		return (
			`Blocked: sleeping ${Math.round(seconds)}s in bash blocks the session. To wait for something, start a monitor ` +
			"and keep working: `monitor` with gh_run, gh_pr, url, pid, file or a command that prints when ready. " +
			"It reports back on its own."
		);
	}
	return undefined;
}
