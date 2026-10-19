import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MonitorEntry, MonitorSpec } from "../src/registry.ts";
import { planResume } from "../src/resume.ts";
import { harness } from "./harness.ts";
import { until } from "./helpers.ts";

const ghSpec: MonitorSpec = {
	description: "CI",
	kind: "gh_run",
	target: "latest",
	wake: "final",
	timeoutMinutes: 30,
	cwd: "/repo",
	reportOutput: false,
};
const cmdSpec: MonitorSpec = {
	description: "server",
	kind: "command",
	target: "npm run dev",
	wake: "events",
	timeoutMinutes: 30,
	cwd: "/repo",
	reportOutput: false,
};

const entry = (data: MonitorEntry) => ({ type: "custom", customType: "monitor-state", data });

describe("resume", () => {
	it("restarts unfinished gh watchers with the resolved run and ends the rest", () => {
		const plan = planResume(
			[
				entry({ kind: "start", id: "m1", spec: ghSpec, startedAt: 1 }),
				entry({ kind: "resolve", id: "m1", target: "https://github.com/acme/app/actions/runs/1001" }),
				entry({ kind: "start", id: "m2", spec: cmdSpec, startedAt: 2 }),
				entry({ kind: "start", id: "m3", spec: cmdSpec, startedAt: 3 }),
				entry({ kind: "end", id: "m3", status: "success", summary: "ok", endedAt: 4 }),
				{ type: "custom", customType: "other", data: { kind: "start", id: "x" } },
			],
			"monitor-state",
		);
		assert.deepEqual(plan.restart, [
			{ id: "m1", spec: { ...ghSpec, target: "https://github.com/acme/app/actions/runs/1001" }, startedAt: 1 },
		]);
		assert.deepEqual(
			plan.ended.map((e) => e.id),
			["m2"],
		);
		assert.deepEqual(plan.ids, ["m1", "m2", "m3"]);
	});

	it("restarts gh watchers that were stopped by a session shutdown", () => {
		const plan = planResume(
			[
				entry({ kind: "start", id: "m1", spec: ghSpec, startedAt: 1 }),
				entry({
					kind: "end",
					id: "m1",
					status: "stopped",
					summary: "stopped at session shutdown after 5s",
					endedAt: 2,
					reason: "shutdown",
				}),
				entry({ kind: "start", id: "m2", spec: ghSpec, startedAt: 1 }),
				entry({
					kind: "end",
					id: "m2",
					status: "stopped",
					summary: "stopped by the user after 5s",
					endedAt: 2,
					reason: "user",
				}),
			],
			"monitor-state",
		);
		assert.deepEqual(
			plan.restart.map((r) => r.id),
			["m1"],
		);
	});

	it("restarts a gh watcher on session_start, marks commands ended and continues the id sequence", async () => {
		const calls: string[] = [];
		const branch = [
			entry({ kind: "start", id: "m1", spec: { ...ghSpec, target: "1001" }, startedAt: Date.now() - 60_000 }),
			entry({ kind: "start", id: "m2", spec: cmdSpec, startedAt: Date.now() - 60_000 }),
		];
		const h = harness({
			branch,
			overrides: {
				run: async (command, args) => {
					calls.push([command, ...args].join(" "));
					return {
						stdout: JSON.stringify({
							status: "completed",
							conclusion: "success",
							jobs: [],
							workflowName: "CI",
							number: 9,
						}),
						stderr: "",
						code: 0,
					};
				},
			},
		});
		await h.fire("session_start", { reason: "resume" });
		await until(() => h.sent.length > 0);
		assert.match(calls[0]!, /^gh run view 1001 --json/);
		assert.match(h.sent[0]!.message.content, /\[monitor m1 "CI"\] done: CI #9 green/);
		const ends = h.entries.filter((e) => e.data.kind === "end");
		assert.deepEqual(
			ends.map((e) => [e.data.id, e.data.status]),
			[
				["m2", "ended"],
				["m1", "success"],
			],
		);
		assert.equal(
			h.entries.filter((e) => e.data.kind === "start").length,
			0,
			"a restart does not record a second start",
		);
		const next = await h.call("monitor", { description: "new", command: "true" });
		assert.match(next.content[0]!.text, /^Started m3 /);
	});
});
