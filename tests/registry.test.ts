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
import { until } from "./helpers.ts";

function registry(maxConcurrent = 5) {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-registry-"));
	const sent: OutgoingMessage[] = [];
	const entries: MonitorEntry[] = [];
	const delivery = new Delivery({ send: (message) => sent.push(message), isIdle: () => true });
	const reg = new Registry({
		delivery,
		buildSource,
		openLog: (id) => MonitorLog.open(dir, id),
		run: defaultRun,
		cwd: () => tmpdir(),
		maxConcurrent: () => maxConcurrent,
		persist: (entry) => entries.push(entry),
		onChange: () => {},
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
		});
		assert.equal(started.id, "m1");
		assert.equal(
			started.text,
			'Started m1 "unit tests" (echo ok). You will be notified when it ends. Continue with other work.',
		);
		await until(() => sent.length > 0);
		assert.match(sent[0]!.content, /SUCCEEDED: exited 0/);
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
		});
		await until(() => record.status !== "running");
		assert.equal(record.lastLine, cwd);
	});

	it("refuses to start beyond maxConcurrent", () => {
		const { reg } = registry(1);
		startMonitor(reg, { description: "a", kind: "command", target: "sleep 30", wake: "never", timeoutMinutes: 5 });
		assert.throws(
			() =>
				startMonitor(reg, { description: "b", kind: "command", target: "sleep 30", wake: "never", timeoutMinutes: 5 }),
			MonitorLimitError,
		);
		reg.stopAll();
	});
});
