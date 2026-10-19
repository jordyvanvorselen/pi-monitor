import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Delivery, type OutgoingMessage } from "../src/delivery.ts";
import { defaultRun } from "../src/exec.ts";
import { SafetyNet } from "../src/intercept/safety-net.ts";
import { MonitorLog } from "../src/log.ts";
import { Registry } from "../src/registry.ts";
import { buildSource } from "../src/sources/index.ts";
import { until } from "./helpers.ts";

function setup(thresholdSeconds = 1) {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-net-"));
	const sent: OutgoingMessage[] = [];
	const delivery = new Delivery({ send: (m) => sent.push(m), isIdle: () => true });
	const registry = new Registry({
		delivery,
		buildSource,
		openLog: (id) => MonitorLog.open(dir, id),
		run: defaultRun,
		cwd: () => tmpdir(),
		maxConcurrent: () => 5,
		persist: () => {},
		onChange: () => {},
	});
	const net = new SafetyNet({
		registry,
		logDir: () => dir,
		shell: () => ({ path: "bash" }),
		thresholdSeconds: () => thresholdSeconds,
	});
	return { registry, net, sent, dir };
}

/** Run the wait script like the bash tool would. */
function runScript(script: string): Promise<{ stdout: string; code: number | null; ms: number }> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", script]);
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.on("close", (code) => resolve({ stdout, code, ms: Date.now() - started }));
	});
}

describe("safety net", () => {
	it("hands back the output and exit code of a command that ends in time, and leaves no monitor", async () => {
		const { registry, net } = setup();
		const { id, script } = net.start("call-1", "echo building; sleep 0.05; echo oops >&2; exit 3", tmpdir());
		assert.ok(registry.get(id)!.probationUntil !== undefined, "on probation while bash still waits");
		const result = await runScript(script);
		assert.equal(result.code, 3);
		assert.equal(result.stdout, "building\noops\n");
		await until(() => registry.get(id) === undefined);
		net.toolEnded("call-1");
	});

	it("moves a command that keeps running to the background and wakes the model when it ends", async () => {
		const { registry, net, sent } = setup(1);
		const { id, script } = net.start("call-1", "echo started; sleep 2; echo finished", tmpdir());
		const result = await runScript(script);
		assert.equal(result.code, 0);
		assert.match(
			result.stdout,
			/^started\nStill running after 1s\. Moved to background as m1 \(echo started; sleep 2; echo finished\)\. You will be notified when it ends\.\n$/,
		);
		assert.ok(result.ms < 2000, `returned after ${result.ms} ms`);
		net.toolEnded("call-1");
		const record = registry.get(id)!;
		assert.equal(record.probationUntil, undefined);
		assert.equal(record.wake, "final");
		await until(() => sent.length > 0, 5000);
		assert.match(sent[0]!.content, /done: exited 0 after 2s\noutput:\n {2}started\n {2}finished$/);
	});

	it("honours a bash timeout shorter than the threshold: kills the command and exits 124", async () => {
		const { registry, net, sent } = setup(30);
		const { id, script } = net.start("call-1", "sleep 30", tmpdir(), 1);
		const result = await runScript(script);
		assert.equal(result.code, 124);
		assert.match(result.stdout, /Command timed out after 1s\./);
		await until(() => registry.get(id) === undefined);
		assert.equal(sent.length, 0);
	});

	it("stops the command when the bash call ends before a decision, e.g. on abort", async () => {
		const { registry, net, sent } = setup(30);
		const { id } = net.start("call-1", "sleep 30", tmpdir());
		net.toolEnded("call-1");
		await until(() => registry.get(id) === undefined);
		assert.equal(sent.length, 0);
	});

	it("reports a shell that cannot start as exit 127", async () => {
		const { net } = setup();
		const broken = new SafetyNet({
			registry: (net as unknown as { deps: { registry: Registry } }).deps.registry,
			logDir: () => mkdtempSync(join(tmpdir(), "pi-monitor-net-")),
			shell: () => ({ path: "/no/such/shell" }),
			thresholdSeconds: () => 5,
		});
		const { script } = broken.start("call-2", "echo hi", tmpdir());
		const result = await runScript(script);
		assert.equal(result.code, 127);
		assert.match(result.stdout, /could not start \/no\/such\/shell/);
	});
});
