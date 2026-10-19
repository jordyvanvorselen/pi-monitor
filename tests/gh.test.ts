import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { diffJobs, median, pollDelay, snapshot } from "../src/sources/gh.ts";
import { checksToJobs, ghPrSource, parsePrTarget } from "../src/sources/gh-pr.ts";
import { ghRunSource, jobState, parseRunTarget, toJobs, type GhRun } from "../src/sources/gh-run.ts";
import type { MonitorEvent, Progress, Run, RunResult, SourceContext } from "../src/sources/types.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
const failedLog = readFileSync(join(fixtures, "gh-log-failed.txt"), "utf8");

type Responder = (args: string[]) => RunResult | undefined;

/** Fake `run`: answers by matching the joined command line and records every call. */
function fakeRun(responders: [RegExp, Responder | RunResult][]) {
	const calls: string[] = [];
	const run: Run = async (command, args) => {
		const line = [command, ...args].join(" ");
		calls.push(line);
		for (const [pattern, answer] of responders) {
			if (!pattern.test(line)) continue;
			const result = typeof answer === "function" ? answer(args) : answer;
			if (result) return result;
		}
		return { stdout: "", stderr: `unexpected: ${line}`, code: 1 };
	};
	return { run, calls };
}

const json = (value: unknown): RunResult => ({ stdout: JSON.stringify(value), stderr: "", code: 0 });

function sequence(values: unknown[]): Responder {
	let i = 0;
	return () => json(values[Math.min(i++, values.length - 1)]);
}

function context(run: Run) {
	let time = Date.parse("2024-05-01T12:00:00Z");
	const events: MonitorEvent[] = [];
	const updates: Partial<Progress>[] = [];
	const controller = new AbortController();
	const ctx: SourceContext = {
		signal: controller.signal,
		cwd: "/repo",
		run,
		startedAt: time,
		now: () => time,
		sleep: async (ms) => {
			time += ms;
		},
		emit: (event) => events.push(event),
		line: () => {},
		update: (progress) => updates.push(progress),
	};
	const progress = () => Object.assign({}, ...updates) as Progress;
	return { ctx, events, updates, progress, controller };
}

describe("gh helpers", () => {
	it("backs off from 5 s to 15 s to 30 s", () => {
		assert.equal(pollDelay(10_000), 5_000);
		assert.equal(pollDelay(90_000), 15_000);
		assert.equal(pollDelay(600_000), 30_000);
	});

	it("takes the median of durations", () => {
		assert.equal(median([4, 1, 9]), 4);
		assert.equal(median([1, 2, 3, 4]), 3);
		assert.equal(median([]), undefined);
	});

	it("maps gh status and conclusion to job states", () => {
		assert.equal(jobState("queued", null), "queued");
		assert.equal(jobState("in_progress", null), "running");
		assert.equal(jobState("completed", "success"), "success");
		assert.equal(jobState("completed", "timed_out"), "failure");
		assert.equal(jobState("completed", "skipped"), "skipped");
	});

	it("parses run ids, run URLs, latest and next", () => {
		assert.deepEqual(parseRunTarget("123"), { id: "123" });
		assert.deepEqual(parseRunTarget("https://github.com/acme/app/actions/runs/456/job/7"), {
			id: "456",
			repo: "acme/app",
		});
		assert.deepEqual(parseRunTarget("latest"), { latest: true });
		assert.deepEqual(parseRunTarget("next"), { next: true });
		assert.throws(() => parseRunTarget("main"), /run id, a run URL, "latest" or "next"/);
	});

	it("parses PR numbers and URLs", () => {
		assert.deepEqual(parsePrTarget("#42"), { pr: "42" });
		assert.deepEqual(parsePrTarget("https://github.com/acme/app/pull/42"), { pr: "42", repo: "acme/app" });
	});

	it("emits only changes between two polls", () => {
		const polls = load<GhRun[]>("gh-run-failing.json");
		const first = toJobs(polls[1]!);
		const changes = diffJobs(new Map(), first);
		assert.deepEqual(
			changes.map((c) => `${c.type} ${c.job.name}`),
			["passed build", "started test"],
		);
		const second = diffJobs(snapshot(first), toJobs(polls[2]!));
		assert.deepEqual(
			second.map((c) => `${c.type} ${c.job.name}`),
			["failed test", "started lint"],
		);
		assert.deepEqual(diffJobs(snapshot(toJobs(polls[2]!)), toJobs(polls[2]!)), []);
	});

	it("names the step that runs now, or the step that failed", () => {
		const polls = load<GhRun[]>("gh-run-failing.json");
		assert.equal(toJobs(polls[1]!).find((j) => j.name === "test")!.step, "Run unit tests");
		assert.equal(toJobs(polls[2]!).find((j) => j.name === "test")!.step, "Run unit tests");
	});
});

describe("gh_run source", () => {
	it("reports job changes, wakes on the failed job with a cleaned log tail and ends failed", async () => {
		const { run, calls } = fakeRun([
			[/gh run view 1001 --json/, sequence(load("gh-run-failing.json"))],
			[/gh run view 1001 --job 2 --log-failed/, { stdout: failedLog, stderr: "", code: 0 }],
			[/gh run list --workflow 77 --status success/, json(load("gh-run-history.json"))],
		]);
		const { ctx, events, progress } = context(run);
		const outcome = await ghRunSource("1001").start(ctx);

		assert.deepEqual(
			events.map((e) => `${e.level}: ${e.text}`),
			[
				'notable: job "build" passed in 1m02s',
				'progress: job "test" started',
				'failure: job "test" failed',
				'progress: job "lint" started',
				'notable: job "lint" passed in 2m08s',
			],
		);
		const failure = events.find((e) => e.level === "failure")!;
		assert.equal(failure.context, 'job "test" step "Run unit tests" failed:');
		assert.deepEqual(failure.detail, [
			"> pi-monitor@0.1.0 test",
			"✗ extension.test.ts > loads rules lazily",
			"    Expected 2, received 3 (tests/extension.test.ts:88)",
			"error: Process completed with exit code 1.",
		]);
		assert.equal(outcome.status, "failure");
		assert.equal(outcome.summary, "CI #42 failure after 6m12s: test");
		assert.equal(outcome.detail, undefined, "logs already went out with the failure event");

		const p = progress();
		assert.equal(p.title, "CI #42");
		assert.equal(p.url, "https://github.com/acme/app/actions/runs/1001");
		assert.equal(p.etaMs, 6 * 60_000);
		assert.equal(calls.filter((c) => c.includes("--workflow")).length, 1, "history is fetched once");
	});

	it("ends green with the run duration", async () => {
		const { run } = fakeRun([
			[/gh run view 1001 --json/, sequence(load("gh-run-green.json"))],
			[/gh run list --workflow/, json([])],
		]);
		const { ctx } = context(run);
		const outcome = await ghRunSource("1001").start(ctx);
		assert.deepEqual(outcome, { status: "success", summary: "CI #42 green in 6m02s" });
	});

	it("passes -R for run URLs", async () => {
		const { run, calls } = fakeRun([
			[/gh run view 1001 --json/, sequence(load("gh-run-green.json"))],
			[/gh run list/, json([])],
		]);
		await ghRunSource("https://github.com/acme/app/actions/runs/1001").start(context(run).ctx);
		assert.match(calls[0]!, /-R acme\/app$/);
	});

	it("resolves latest to the newest run for HEAD on the current branch", async () => {
		const { run, calls } = fakeRun([
			[/^git branch --show-current/, { stdout: "feature\n", stderr: "", code: 0 }],
			[/^git rev-parse HEAD/, { stdout: "abc\n", stderr: "", code: 0 }],
			[
				/gh run list --branch feature/,
				sequence([
					[{ databaseId: 1, headSha: "old", createdAt: "2024-05-01T11:00:00Z" }],
					[
						{ databaseId: 1, headSha: "old", createdAt: "2024-05-01T11:00:00Z" },
						{ databaseId: 1001, headSha: "abc", createdAt: "2024-05-01T12:00:00Z" },
					],
				]),
			],
			[/gh run view 1001 --json/, sequence(load("gh-run-green.json"))],
			[/gh run list --workflow/, json([])],
		]);
		const outcome = await ghRunSource("latest").start(context(run).ctx);
		assert.equal(outcome.status, "success");
		assert.equal(calls.filter((c) => c.includes("--branch feature")).length, 2, "waits for the run to appear");
	});

	it("returns the result of an already finished latest run at once, without polling", async () => {
		const completed = load<GhRun[]>("gh-run-green.json")[1]!;
		const { run, calls } = fakeRun([
			[/^git branch --show-current/, { stdout: "main\n", stderr: "", code: 0 }],
			[/^git rev-parse HEAD/, { stdout: "abc\n", stderr: "", code: 0 }],
			[/gh run list --branch main/, json([{ databaseId: 1001, headSha: "abc", createdAt: "2024-05-01T11:00:00Z" }])],
			[/gh run view 1001 --json/, json(completed)],
			[/gh run list --workflow/, json([])],
		]);
		const c = context(run);
		let slept = 0;
		c.ctx.sleep = async () => {
			slept++;
		};
		const outcome = await ghRunSource("latest").start(c.ctx);
		assert.deepEqual(outcome, { status: "success", summary: "CI #42 green in 6m02s" });
		assert.equal(calls.filter((call) => call.startsWith("gh run view")).length, 1);
		assert.equal(slept, 0);
	});

	it("next waits for the first run created after the monitor started, then watches it", async () => {
		const { run, calls } = fakeRun([
			[/^git branch --show-current/, { stdout: "feature\n", stderr: "", code: 0 }],
			[
				/gh run list --branch feature --limit 20/,
				sequence([
					[{ databaseId: 900, createdAt: "2024-05-01T11:00:00Z", status: "completed" }],
					[{ databaseId: 900, createdAt: "2024-05-01T11:00:00Z", status: "completed" }],
					[
						{ databaseId: 1002, createdAt: "2024-05-01T12:00:40Z", status: "queued" },
						{ databaseId: 1001, createdAt: "2024-05-01T12:00:20Z", status: "in_progress" },
						{ databaseId: 900, createdAt: "2024-05-01T11:00:00Z", status: "completed" },
					],
				]),
			],
			[/gh run view 1001 --json/, sequence(load("gh-run-green.json"))],
			[/gh run list --workflow/, json([])],
		]);
		const c = context(run);
		const outcome = await ghRunSource("next").start(c.ctx);
		assert.equal(outcome.status, "success");
		assert.equal(calls.filter((call) => call.includes("--branch feature")).length, 3, "polls until a new run shows up");
		assert.ok(
			calls.some((call) => call.startsWith("gh run view 1001")),
			"watches the earliest new run",
		);
		assert.equal(c.progress().title, "CI #42");
	});

	it("next uses the given branch and workflow instead of the current branch", async () => {
		const { run, calls } = fakeRun([
			[
				/gh run list --branch release --workflow ci\.yml --limit 20/,
				json([{ databaseId: 1001, createdAt: "2024-05-01T12:00:10Z", status: "queued" }]),
			],
			[/gh run view 1001 --json/, sequence(load("gh-run-green.json"))],
			[/gh run list --workflow 77/, json([])],
		]);
		const outcome = await ghRunSource("next", { branch: "release", workflow: "ci.yml" }).start(context(run).ctx);
		assert.equal(outcome.status, "success");
		assert.ok(!calls.some((call) => call.startsWith("git ")), "no git call with an explicit branch");
	});

	it("next stops quietly when the monitor stops before a run appears", async () => {
		const { run } = fakeRun([[/gh run list --branch main/, json([])]]);
		const c = context(run);
		c.ctx.sleep = async () => c.controller.abort();
		const outcome = await ghRunSource("next", { branch: "main" }).start(c.ctx);
		assert.equal(outcome.status, "stopped");
	});

	it("gives up at once when gh is not authenticated", async () => {
		const { run } = fakeRun([
			[/gh run view/, { stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", code: 4 }],
		]);
		const outcome = await ghRunSource("1001").start(context(run).ctx);
		assert.deepEqual(outcome, { status: "failure", summary: "gh is not authenticated. Run `gh auth login`." });
	});

	it("retries transient gh errors and gives up after five in a row", async () => {
		const { run, calls } = fakeRun([[/gh run view/, { stdout: "", stderr: "HTTP 502: Bad gateway", code: 1 }]]);
		const outcome = await ghRunSource("1001").start(context(run).ctx);
		assert.equal(outcome.status, "failure");
		assert.match(outcome.summary, /gh failed 5 times in a row: HTTP 502/);
		assert.equal(calls.length, 5);
	});

	it("stops quietly when aborted", async () => {
		const { run } = fakeRun([[/gh run view 1001 --json/, sequence([load<GhRun[]>("gh-run-failing.json")[0]])]]);
		const c = context(run);
		c.ctx.sleep = async () => c.controller.abort();
		const outcome = await ghRunSource("1001").start(c.ctx);
		assert.equal(outcome.status, "stopped");
	});
});

describe("gh_pr source", () => {
	it("maps checks to jobs with the workflow name", () => {
		const jobs = checksToJobs(load<Parameters<typeof checksToJobs>[0][]>("gh-pr-checks.json")[1]!);
		assert.deepEqual(
			jobs.map((j) => `${j.name}:${j.state}`),
			["CI / build:running", "vercel:success"],
		);
	});

	it("wakes on a failed check with its Actions log and ends when nothing is pending", async () => {
		const { run } = fakeRun([
			[/gh pr view 42/, json({ number: 42, url: "https://github.com/acme/app/pull/42" })],
			[/gh pr checks 42/, sequence(load("gh-pr-checks.json"))],
			[/gh run view 1001 --job 1 --log-failed -R acme\/app/, { stdout: failedLog, stderr: "", code: 0 }],
		]);
		const { ctx, events, progress } = context(run);
		const outcome = await ghPrSource("42").start(ctx);
		assert.deepEqual(
			events.map((e) => `${e.level}: ${e.text}`),
			['progress: check "CI / build" started', 'notable: check "vercel" passed', 'failure: check "CI / build" failed'],
		);
		assert.match(events[2]!.detail!.join("\n"), /loads rules lazily/);
		assert.equal(outcome.status, "failure");
		assert.equal(outcome.summary, "PR #42: 1 of 2 checks failed: CI / build");
		assert.equal(progress().url, "https://github.com/acme/app/pull/42");
	});

	it("keeps waiting while no checks are reported yet", async () => {
		let polls = 0;
		const { run } = fakeRun([
			[/gh pr view/, json({ number: 7 })],
			[
				/gh pr checks 7/,
				() =>
					polls++ < 2
						? { stdout: "", stderr: "no checks reported on the 'x' branch", code: 1 }
						: json([{ name: "build", bucket: "pass", state: "SUCCESS" }]),
			],
		]);
		const outcome = await ghPrSource("7").start(context(run).ctx);
		assert.equal(outcome.status, "success");
		assert.match(outcome.summary, /^PR #7 checks green after/);
	});
});
