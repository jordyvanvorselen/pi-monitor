import { excerpt } from "../format.ts";
import type { Job, JobState, Run, SourceContext } from "./types.ts";

export const RUN_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/;

/** Polling backoff: every 5 s in the first minute, then 15 s, then 30 s after five minutes. */
export function pollDelay(elapsedMs: number): number {
	if (elapsedMs < 60_000) return 5_000;
	if (elapsedMs < 300_000) return 15_000;
	return 30_000;
}

export function repoArgs(repo: string | undefined): string[] {
	return repo ? ["-R", repo] : [];
}

/** gh uses `0001-01-01T00:00:00Z` for "not yet". */
export function parseTime(value: string | undefined | null): number | undefined {
	if (!value) return undefined;
	const t = Date.parse(value);
	return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t : undefined;
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export type JobChange = { type: "started" | "passed" | "failed"; job: Job };

const keyOf = (job: Job) => (job.id !== undefined ? `#${job.id}` : job.name);

/** Compare two job lists. Only changes come out: started, passed, failed. */
export function diffJobs(previous: ReadonlyMap<string, JobState>, jobs: readonly Job[]): JobChange[] {
	const changes: JobChange[] = [];
	for (const job of jobs) {
		const before = previous.get(keyOf(job));
		if (before === job.state) continue;
		if (job.state === "running" && (before === undefined || before === "queued"))
			changes.push({ type: "started", job });
		else if (job.state === "success") changes.push({ type: "passed", job });
		else if (job.state === "failure") changes.push({ type: "failed", job });
	}
	return changes;
}

export function snapshot(jobs: readonly Job[]): Map<string, JobState> {
	return new Map(jobs.map((job) => [keyOf(job), job.state]));
}

export interface GhFailure {
	kind: "auth" | "missing" | "other";
	message: string;
}

export function classifyGhError(stderr: string, code: number): GhFailure {
	if (code === 127 || /ENOENT|command not found/i.test(stderr))
		return { kind: "missing", message: "the gh CLI is not installed or not on PATH" };
	if (/gh auth login|not logged in|authentication|HTTP 401/i.test(stderr))
		return { kind: "auth", message: "gh is not authenticated. Run `gh auth login`." };
	return { kind: "other", message: stderr.trim().split("\n").slice(-1)[0] || `gh exited with code ${code}` };
}

/** Run gh and parse JSON. Throws GhError on failure so callers can count retries. */
export class GhError extends Error {
	readonly failure: GhFailure;
	constructor(failure: GhFailure) {
		super(failure.message);
		this.failure = failure;
	}
}

export async function ghJson<T>(run: Run, args: string[], ctx: Pick<SourceContext, "signal" | "cwd">): Promise<T> {
	const result = await run("gh", args, { signal: ctx.signal, cwd: ctx.cwd });
	const text = result.stdout.trim();
	// `gh pr checks` exits 8 while checks are pending but still prints JSON.
	if (text.startsWith("[") || text.startsWith("{")) {
		try {
			return JSON.parse(text) as T;
		} catch {
			// fall through to the error below
		}
	}
	throw new GhError(classifyGhError(result.stderr || result.stdout, result.code || 1));
}

/** Tail of the failed steps of one job, cleaned and capped at 30 lines. Empty when logs are not ready yet. */
export async function fetchFailedLog(
	run: Run,
	runId: string,
	jobId: number,
	repo: string | undefined,
	ctx: Pick<SourceContext, "signal" | "cwd">,
): Promise<{ lines: string[]; dropped: number }> {
	const result = await run("gh", ["run", "view", runId, "--job", String(jobId), "--log-failed", ...repoArgs(repo)], {
		signal: ctx.signal,
		cwd: ctx.cwd,
	});
	if (result.code !== 0 || !result.stdout.trim()) return { lines: [], dropped: 0 };
	return excerpt(result.stdout.split("\n"), 30);
}

/** Counts consecutive gh errors. Auth and missing-gh errors end the monitor at once. */
export class ErrorBudget {
	private count = 0;
	private readonly limit: number;

	constructor(limit = 5) {
		this.limit = limit;
	}

	ok(): void {
		this.count = 0;
	}

	/** Returns a message when the monitor should give up. */
	fail(error: unknown): string | undefined {
		if (!(error instanceof GhError)) return error instanceof Error ? error.message : String(error);
		if (error.failure.kind !== "other") return error.failure.message;
		this.count++;
		return this.count >= this.limit ? `gh failed ${this.count} times in a row: ${error.message}` : undefined;
	}
}
