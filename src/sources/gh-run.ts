import { formatDuration } from "../format.ts";
import {
	diffJobs,
	ErrorBudget,
	fetchFailedLog,
	ghJson,
	median,
	parseTime,
	pollDelay,
	repoArgs,
	RUN_URL,
	snapshot,
} from "./gh.ts";
import type { Job, JobState, Outcome, Source, SourceContext } from "./types.ts";

export interface GhStep {
	name: string;
	status: string;
	conclusion: string | null;
	number?: number;
}

export interface GhJob {
	databaseId: number;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt?: string;
	completedAt?: string;
	url?: string;
	steps?: GhStep[];
}

export interface GhRun {
	status: string;
	conclusion: string | null;
	jobs: GhJob[];
	name?: string;
	workflowName?: string;
	displayTitle?: string;
	number?: number;
	url?: string;
	workflowDatabaseId?: number;
	startedAt?: string;
	createdAt?: string;
	updatedAt?: string;
}

interface RunListItem {
	databaseId: number;
	headSha?: string;
	createdAt?: string;
	startedAt?: string;
	updatedAt?: string;
}

export const RUN_FIELDS =
	"status,conclusion,jobs,name,workflowName,displayTitle,number,url,workflowDatabaseId,startedAt,createdAt,updatedAt";

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

export function parseRunTarget(target: string): { id?: string; repo?: string; latest?: boolean; next?: boolean } {
	const value = target.trim();
	if (value === "latest") return { latest: true };
	if (value === "next") return { next: true };
	if (/^\d+$/.test(value)) return { id: value };
	const url = RUN_URL.exec(value);
	if (url) return { id: url[2]!, repo: url[1]! };
	throw new Error(`gh_run must be a run id, a run URL, "latest" or "next". Got "${target}".`);
}

export function jobState(status: string, conclusion: string | null): JobState {
	if (status !== "completed") return status === "in_progress" ? "running" : "queued";
	if (conclusion === "success") return "success";
	if (conclusion && FAILED.has(conclusion)) return "failure";
	return "skipped";
}

/** The step that runs now, or for a failed job the step that failed. */
function currentStep(job: GhJob): string | undefined {
	const steps = job.steps ?? [];
	const failed = steps.find((s) => s.conclusion && FAILED.has(s.conclusion));
	if (failed) return failed.name;
	return steps.find((s) => s.status === "in_progress")?.name;
}

export function toJobs(run: GhRun): Job[] {
	return run.jobs.map((job) => {
		const out: Job = { name: job.name, id: job.databaseId, state: jobState(job.status, job.conclusion) };
		const started = parseTime(job.startedAt);
		const completed = parseTime(job.completedAt);
		const step = currentStep(job);
		if (started !== undefined) out.startedAt = started;
		if (completed !== undefined) out.completedAt = completed;
		if (step) out.step = step;
		if (job.url) out.url = job.url;
		return out;
	});
}

export function runTitle(run: GhRun): string {
	const name = run.workflowName || run.name || "run";
	return run.number ? `${name} #${run.number}` : name;
}

function runDuration(run: GhRun, now: number): number {
	const started = parseTime(run.startedAt) ?? parseTime(run.createdAt) ?? now;
	const ended = run.status === "completed" ? (parseTime(run.updatedAt) ?? now) : now;
	return ended - started;
}

export interface RunFilter {
	/** Branch to look at. Default: the current branch. */
	branch?: string;
	/** Workflow name, file or id, as `gh run list --workflow` takes it. */
	workflow?: string;
}

async function git(ctx: SourceContext, args: string[]): Promise<string> {
	return (await ctx.run("git", args, { signal: ctx.signal, cwd: ctx.cwd })).stdout.trim();
}

async function branchFor(ctx: SourceContext, filter: RunFilter, target: string): Promise<string> {
	const branch = filter.branch ?? (await git(ctx, ["branch", "--show-current"]));
	if (!branch) throw new Error(`gh_run "${target}" needs a checked-out branch or a branch field.`);
	return branch;
}

function listArgs(branch: string, filter: RunFilter, repo: string | undefined, limit: number): string[] {
	const workflow = filter.workflow ? ["--workflow", filter.workflow] : [];
	return [
		"run",
		"list",
		"--branch",
		branch,
		...workflow,
		"--limit",
		String(limit),
		"--json",
		"databaseId,headSha,createdAt,status",
		...repoArgs(repo),
	];
}

async function resolveLatest(ctx: SourceContext, filter: RunFilter, repo?: string): Promise<string> {
	const branch = await branchFor(ctx, filter, "latest");
	const head = await git(ctx, ["rev-parse", "HEAD"]);
	const deadline = ctx.now() + 60_000;
	let runs: RunListItem[];
	for (;;) {
		runs = await ghJson<RunListItem[]>(ctx.run, listArgs(branch, filter, repo, 10), ctx);
		const forHead = runs
			.filter((r) => r.headSha === head)
			.sort((a, b) => (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0));
		if (forHead[0]) return String(forHead[0].databaseId);
		if (ctx.now() >= deadline || ctx.signal.aborted) break;
		await ctx.sleep(5_000);
	}
	if (runs[0]) return String(runs[0].databaseId);
	throw new Error(`No GitHub Actions run found for branch ${branch} after 60s.`);
}

/** Runs created this long before the monitor started still count as "next" (clock skew). */
const NEXT_SKEW_MS = 5_000;

/**
 * Wait for the first run on the branch that was created after the monitor started.
 * Polls with the usual backoff until it appears; the monitor timeout ends the wait.
 */
async function waitForNext(ctx: SourceContext, filter: RunFilter, repo?: string): Promise<string | undefined> {
	const branch = await branchFor(ctx, filter, "next");
	const since = ctx.startedAt - NEXT_SKEW_MS;
	const budget = new ErrorBudget();
	ctx.update({ title: `next run on ${branch}` });
	while (!ctx.signal.aborted) {
		try {
			const runs = await ghJson<RunListItem[]>(ctx.run, listArgs(branch, filter, repo, 20), ctx);
			budget.ok();
			const next = runs
				.filter((r) => (parseTime(r.createdAt) ?? 0) >= since)
				.sort((a, b) => (parseTime(a.createdAt) ?? 0) - (parseTime(b.createdAt) ?? 0))[0];
			if (next) return String(next.databaseId);
		} catch (error) {
			if (ctx.signal.aborted) break;
			const fatal = budget.fail(error);
			if (fatal) throw new Error(fatal, { cause: error });
		}
		await ctx.sleep(pollDelay(ctx.now() - ctx.startedAt));
	}
	return undefined;
}

/** Median duration of the last successful runs of the same workflow. */
async function typicalDuration(ctx: SourceContext, workflowId: number, exclude: string, repo?: string) {
	const runs = await ghJson<RunListItem[]>(
		ctx.run,
		[
			"run",
			"list",
			"--workflow",
			String(workflowId),
			"--status",
			"success",
			"--limit",
			"10",
			"--json",
			"databaseId,startedAt,createdAt,updatedAt",
			...repoArgs(repo),
		],
		ctx,
	);
	const durations = runs
		.filter((r) => String(r.databaseId) !== exclude)
		.map((r) => (parseTime(r.updatedAt) ?? 0) - (parseTime(r.startedAt) ?? parseTime(r.createdAt) ?? Infinity))
		.filter((d) => d > 0 && Number.isFinite(d));
	return median(durations);
}

/**
 * Watches one GitHub Actions run with `gh run view`. Emits only changes: job started (progress),
 * job passed (notable), job failed (failure, with the tail of its failed log).
 */
export function ghRunSource(target: string, filter: RunFilter = {}): Source {
	const parsed = parseRunTarget(target);
	const on = filter.branch ? ` on ${filter.branch}` : "";
	return {
		kind: "gh_run",
		label: parsed.latest ? `gh run latest${on}` : parsed.next ? `next gh run${on}` : `gh run ${parsed.id}`,
		async start(ctx) {
			const repo = parsed.repo;
			let runId: string;
			try {
				const resolved =
					parsed.id ?? (parsed.next ? await waitForNext(ctx, filter, repo) : await resolveLatest(ctx, filter, repo));
				if (resolved === undefined) return { status: "stopped", summary: "stopped" };
				runId = resolved;
			} catch (error) {
				if (ctx.signal.aborted) return { status: "stopped", summary: "stopped" };
				return { status: "failure", summary: (error as Error).message };
			}
			const started = ctx.now();
			const budget = new ErrorBudget();
			let previous = new Map<string, JobState>();
			let etaAsked = false;
			const reported = new Map<number, { lines: string[]; dropped: number; step?: string }>();

			while (!ctx.signal.aborted) {
				let run: GhRun;
				try {
					run = await ghJson<GhRun>(ctx.run, ["run", "view", runId, "--json", RUN_FIELDS, ...repoArgs(repo)], ctx);
					budget.ok();
				} catch (error) {
					if (ctx.signal.aborted) break;
					const fatal = budget.fail(error);
					if (fatal) return { status: "failure", summary: fatal };
					await ctx.sleep(pollDelay(ctx.now() - started));
					continue;
				}
				const jobs = toJobs(run);
				const title = runTitle(run);
				const runStarted = parseTime(run.startedAt) ?? parseTime(run.createdAt);
				ctx.update({
					title,
					jobs,
					...(run.url ? { url: run.url } : {}),
					...(runStarted !== undefined ? { startedAt: runStarted } : {}),
				});
				if (!etaAsked && run.workflowDatabaseId) {
					etaAsked = true;
					typicalDuration(ctx, run.workflowDatabaseId, runId, repo)
						.then((eta) => eta && !ctx.signal.aborted && ctx.update({ etaMs: eta }))
						.catch(() => {});
				}

				for (const change of diffJobs(previous, jobs)) {
					const job = change.job;
					if (change.type === "started") ctx.emit({ text: `job "${job.name}" started`, level: "progress" });
					if (change.type === "passed") {
						const took =
							job.startedAt && job.completedAt ? ` in ${formatDuration(job.completedAt - job.startedAt)}` : "";
						ctx.emit({ text: `job "${job.name}" passed${took}`, level: "notable" });
					}
					if (change.type === "failed" && job.id !== undefined) {
						const log = await fetchFailedLog(ctx.run, runId, job.id, repo, ctx);
						reported.set(job.id, { ...log, ...(job.step ? { step: job.step } : {}) });
						ctx.emit({
							text: `job "${job.name}" failed`,
							level: "failure",
							context: job.step ? `job "${job.name}" step "${job.step}" failed:` : `job "${job.name}" failed:`,
							detail: log.lines.length ? log.lines : ["(logs are not available yet)"],
							dropped: log.dropped,
						});
					}
				}
				previous = snapshot(jobs);

				if (run.status === "completed") return finalOutcome(ctx, run, jobs, runId, repo, reported);
				await ctx.sleep(pollDelay(ctx.now() - started));
			}
			return { status: "stopped", summary: "stopped" };
		},
	};
}

async function finalOutcome(
	ctx: SourceContext,
	run: GhRun,
	jobs: Job[],
	runId: string,
	repo: string | undefined,
	reported: Map<number, { lines: string[]; dropped: number }>,
): Promise<Outcome> {
	const title = runTitle(run);
	const took = formatDuration(runDuration(run, ctx.now()));
	if (run.conclusion === "success") return { status: "success", summary: `${title} green in ${took}` };
	if (run.conclusion === "skipped" || run.conclusion === "neutral")
		return { status: "success", summary: `${title} ${run.conclusion} after ${took}` };
	const failed = jobs.filter((j) => j.state === "failure");
	const names = failed.map((j) => j.name).join(", ");
	const summary = `${title} ${run.conclusion ?? "failed"} after ${took}${names ? `: ${names}` : ""}`;
	// The model already saw logs for jobs reported while running. Add logs only when they were missing.
	const first = failed[0];
	const known = first?.id !== undefined ? reported.get(first.id) : undefined;
	if (!first || first.id === undefined || (known && known.lines.length > 0)) return { status: "failure", summary };
	const log = await fetchFailedLog(ctx.run, runId, first.id, repo, ctx);
	if (log.lines.length === 0) return { status: "failure", summary };
	return {
		status: "failure",
		summary,
		context: first.step ? `job "${first.name}" step "${first.step}" failed:` : `job "${first.name}" failed:`,
		detail: log.lines,
		dropped: log.dropped,
	};
}
