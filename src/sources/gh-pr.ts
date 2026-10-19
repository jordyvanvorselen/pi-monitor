import { formatDuration } from "../format.ts";
import {
	diffJobs,
	ErrorBudget,
	fetchFailedLog,
	GhError,
	ghJson,
	parseTime,
	pollDelay,
	RUN_URL,
	snapshot,
} from "./gh.ts";
import type { Job, JobState, Source } from "./types.ts";

export interface GhCheck {
	name: string;
	state?: string;
	bucket: string;
	link?: string;
	startedAt?: string;
	completedAt?: string;
	workflow?: string;
}

export const CHECK_FIELDS = "name,state,bucket,link,startedAt,completedAt,workflow";

export function parsePrTarget(target: string): { pr: string; repo?: string } {
	const value = target.trim().replace(/^#/, "");
	// Empty: the PR of the current branch, like `gh pr checks` without an argument.
	if (value === "" || /^\d+$/.test(value)) return { pr: value };
	const url = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(value);
	if (url) return { pr: url[2]!, repo: url[1]! };
	// gh also accepts a branch name.
	if (/^[\w./-]+$/.test(value)) return { pr: value };
	throw new Error(`gh_pr must be a PR number, PR URL or branch. Got "${target}".`);
}

export function checkState(check: GhCheck): JobState {
	switch (check.bucket) {
		case "pass":
			return "success";
		case "fail":
		case "cancel":
			return "failure";
		case "skipping":
			return "skipped";
		default:
			return check.state === "IN_PROGRESS" || parseTime(check.startedAt) !== undefined ? "running" : "queued";
	}
}

export function checksToJobs(checks: readonly GhCheck[]): Job[] {
	return checks.map((check) => {
		const job: Job = {
			name: check.workflow ? `${check.workflow} / ${check.name}` : check.name,
			state: checkState(check),
		};
		const started = parseTime(check.startedAt);
		const completed = parseTime(check.completedAt);
		if (started !== undefined) job.startedAt = started;
		if (completed !== undefined) job.completedAt = completed;
		if (check.link) job.url = check.link;
		return job;
	});
}

/** Watches all checks of a pull request with `gh pr checks`. */
export function ghPrSource(target: string): Source {
	const { pr, repo } = parsePrTarget(target);
	const repoFlag = repo ? ["-R", repo] : [];
	const prArg = pr ? [pr] : [];
	return {
		kind: "gh_pr",
		label: pr ? `PR #${pr}` : "PR of the current branch",
		async start(ctx) {
			const started = ctx.now();
			const budget = new ErrorBudget();
			let title = /^\d+$/.test(pr) ? `PR #${pr}` : pr || "PR";
			try {
				const view = await ghJson<{ number?: number; url?: string }>(
					ctx.run,
					["pr", "view", ...prArg, "--json", "number,url", ...repoFlag],
					ctx,
				);
				if (view.number) title = `PR #${view.number}`;
				ctx.update({ title, ...(view.url ? { url: view.url } : {}) });
			} catch (error) {
				if (ctx.signal.aborted) return { status: "stopped", summary: "stopped" };
				if (error instanceof GhError && error.failure.kind !== "other")
					return { status: "failure", summary: error.message };
				ctx.update({ title });
			}

			let previous = new Map<string, JobState>();
			while (!ctx.signal.aborted) {
				let checks: GhCheck[];
				try {
					checks = await ghJson<GhCheck[]>(
						ctx.run,
						["pr", "checks", ...prArg, "--json", CHECK_FIELDS, ...repoFlag],
						ctx,
					);
					budget.ok();
				} catch (error) {
					if (ctx.signal.aborted) break;
					// "no checks reported" is a normal state right after a push.
					if (error instanceof GhError && /no checks reported/i.test(error.message)) checks = [];
					else {
						const fatal = budget.fail(error);
						if (fatal) return { status: "failure", summary: fatal };
						await ctx.sleep(pollDelay(ctx.now() - started));
						continue;
					}
				}
				const jobs = checksToJobs(checks);
				ctx.update({ jobs });
				for (const change of diffJobs(previous, jobs)) {
					const job = change.job;
					if (change.type === "started") ctx.emit({ text: `check "${job.name}" started`, level: "progress" });
					if (change.type === "passed") ctx.emit({ text: `check "${job.name}" passed`, level: "notable" });
					if (change.type === "failed") {
						const link = job.url ? RUN_URL.exec(job.url) : null;
						const log =
							link && link[3]
								? await fetchFailedLog(ctx.run, link[2]!, Number(link[3]), link[1], ctx)
								: { lines: [], dropped: 0 };
						ctx.emit({
							text: `check "${job.name}" failed`,
							level: "failure",
							context: `check "${job.name}" failed:`,
							detail: log.lines.length ? log.lines : job.url ? [job.url] : [],
							dropped: log.dropped,
						});
					}
				}
				previous = snapshot(jobs);

				const pending = jobs.some((j) => j.state === "queued" || j.state === "running");
				if (jobs.length > 0 && !pending) {
					const took = formatDuration(ctx.now() - started);
					const failed = jobs.filter((j) => j.state === "failure");
					if (failed.length === 0) return { status: "success", summary: `${title} checks green after ${took}` };
					return {
						status: "failure",
						summary: `${title}: ${failed.length} of ${jobs.length} checks failed: ${failed.map((j) => j.name).join(", ")}`,
					};
				}
				await ctx.sleep(pollDelay(ctx.now() - started));
			}
			return { status: "stopped", summary: "stopped" };
		},
	};
}
