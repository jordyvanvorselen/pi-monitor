import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Delivery, type OutgoingMessage } from "../src/delivery.ts";
import { defaultRun } from "../src/exec.ts";
import { MonitorLog } from "../src/log.ts";
import { MonitorLimitError, Registry, startMonitor, type MonitorEntry } from "../src/registry.ts";
import { buildSource } from "../src/sources/index.ts";
import { FakeClock, until } from "./helpers.ts";

function registry(maxConcurrent = 5, clock?: FakeClock) {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-registry-"));
	const sent: OutgoingMessage[] = [];
	const entries: MonitorEntry[] = [];
	const delivery = new Delivery({
		send: (message) => sent.push(message),
		isIdle: () => true,
		...(clock ? { clock } : {}),
	});
	const reg = new Registry({
		delivery,
		buildSource,
		openLog: (id) => MonitorLog.open(dir, id),
		run: defaultRun,
		cwd: () => tmpdir(),
		maxConcurrent: () => maxConcurrent,
		persist: (entry) => entries.push(entry),
		onChange: () => {},
		...(clock ? { clock } : {}),
	});
	return { reg, sent, entries, dir };
}

describe("startMonitor", () => {
	it("starts a monitor from code and returns its id and the confirmation text", async () => {
		const { reg, sent, entries } = registry();
		const started = startMonitor(reg, {
			description: "unit tests",
			kind: "command",
			target: "echo ok",
			wake: "final",
			timeoutMinutes: 5,
			cwd: "",
			reportOutput: false,
		});
		assert.equal(started.id, "m1");
		assert.equal(
			started.text,
			'Started m1 "unit tests" (echo ok). You will be notified when it ends. Continue with other work.',
		);
		await until(() => sent.length > 0);
		assert.match(sent[0]!.content, /done: exited 0/);
		assert.deepEqual(
			entries.map((e) => e.kind),
			["start", "end"],
		);
	});

	it("runs in the working directory given in the spec", async () => {
		const { reg } = registry();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-monitor-cwd-")));
		const { record } = startMonitor(reg, {
			description: "pwd",
			kind: "command",
			target: "pwd -P",
			wake: "never",
			timeoutMinutes: 5,
			cwd,
			reportOutput: false,
		});
		await until(() => record.status !== "running");
		assert.equal(record.lastLine, cwd);
	});

	it("refuses to start beyond maxConcurrent", () => {
		const { reg } = registry(1);
		startMonitor(reg, {
			description: "a",
			kind: "command",
			target: "sleep 30",
			wake: "never",
			timeoutMinutes: 5,
			cwd: "",
			reportOutput: false,
		});
		assert.throws(
			() =>
				startMonitor(reg, {
					description: "b",
					kind: "command",
					target: "sleep 30",
					wake: "never",
					timeoutMinutes: 5,
					cwd: "",
					reportOutput: false,
				}),
			MonitorLimitError,
		);
		reg.stopAll("shutdown");
	});
});

describe("stop reasons", () => {
	const spec = {
		description: "server",
		kind: "command" as const,
		target: "sleep 30",
		wake: "final" as const,
		timeoutMinutes: 1,
		cwd: "",
		reportOutput: false,
	};
	const end = (entries: MonitorEntry[]) =>
		entries.find((e) => e.kind === "end") as Extract<MonitorEntry, { kind: "end" }>;

	for (const [reason, text] of [
		["user", "stopped by the user"],
		["model", "stopped by the model"],
	] as const) {
		it(`stores "${text}" in the summary and the end entry`, async () => {
			const { reg, entries } = registry();
			const { record } = startMonitor(reg, spec);
			reg.stop(record.id, reason);
			await until(() => record.status !== "running");
			assert.equal(record.status, "stopped");
			assert.match(record.summary!, new RegExp(`^${text} after \\d+s$`));
			assert.equal(end(entries).reason, reason);
			assert.match(end(entries).summary, new RegExp(`^${text}`));
		});
	}

	it("ends a monitor that runs past its timeout as timed out", async () => {
		const clock = new FakeClock();
		const { reg, entries, sent } = registry(5, clock);
		const { record } = startMonitor(reg, spec);
		clock.advance(60_000);
		await until(() => record.status !== "running");
		assert.equal(record.status, "timeout");
		assert.equal(record.summary, "timed out after 1m00s");
		assert.equal(end(entries).reason, "timeout");
		assert.match(sent[0]!.content, /timed out: timed out after 1m00s\nlog: /);
	});

	it("writes the end entry at session shutdown right away and keeps it out of resume's finished list", async () => {
		const { reg, entries } = registry();
		const { record } = startMonitor(reg, spec);
		reg.shutdown();
		const written = end(entries);
		assert.deepEqual([written.status, written.reason], ["stopped", "shutdown"]);
		assert.match(written.summary, /^stopped at session shutdown after/);
		await until(() => record.status !== "running");
		assert.equal(entries.filter((e) => e.kind === "end").length, 1, "no second end entry");
	});
});
