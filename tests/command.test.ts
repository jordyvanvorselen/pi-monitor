import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { abortableSleep, defaultRun } from "../src/exec.ts";
import { commandSource } from "../src/sources/command.ts";
import type { MonitorEvent, Outcome, SourceContext } from "../src/sources/types.ts";

function context(controller = new AbortController()) {
	const lines: { text: string; stream: string }[] = [];
	const events: MonitorEvent[] = [];
	const ctx: SourceContext = {
		signal: controller.signal,
		cwd: tmpdir(),
		run: defaultRun,
		now: () => Date.now(),
		sleep: (ms) => abortableSleep(ms, controller.signal),
		emit: (event) => events.push(event),
		line: (text, stream = "stdout") => lines.push({ text, stream }),
		update: () => {},
	};
	return { ctx, lines, events, controller };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("command source", () => {
	it("reports stdout and stderr lines separately and succeeds on exit 0", async () => {
		const { ctx, lines } = context();
		const outcome = await commandSource("echo one; echo two >&2; echo three").start(ctx);
		assert.equal(outcome.status, "success");
		assert.match(outcome.summary, /^exited 0 after \d+s$/);
		assert.deepEqual(
			lines.map((l) => `${l.stream}:${l.text}`).sort(),
			["stderr:two", "stdout:one", "stdout:three"].sort(),
		);
	});

	it("fails on a non-zero exit code and keeps the last output", async () => {
		const { ctx } = context();
		const outcome = await commandSource("echo building; echo 'error: nope' >&2; exit 3").start(ctx);
		assert.equal(outcome.status, "failure");
		assert.match(outcome.summary, /^exited with code 3/);
		assert.deepEqual(outcome.detail, ["building", "error: nope"]);
	});

	it("kills the whole process group when stopped", async () => {
		const { ctx, lines, controller } = context();
		const running = commandSource("sleep 30 & echo child $!; wait").start(ctx);
		while (!lines.some((l) => l.text.startsWith("child "))) await new Promise((r) => setTimeout(r, 10));
		const childPid = Number(lines.find((l) => l.text.startsWith("child "))!.text.split(" ")[1]);
		assert.ok(alive(childPid), "background child runs before stop");
		controller.abort();
		const outcome: Outcome = await running;
		assert.equal(outcome.status, "stopped");
		for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(alive(childPid), false, "background child is gone after stop");
	});

	it("ends background leftovers when the shell exits by itself", async () => {
		const { ctx, lines } = context();
		const outcome = await commandSource("sleep 30 & echo child $!").start(ctx);
		assert.equal(outcome.status, "success");
		const childPid = Number(lines[0]!.text.split(" ")[1]);
		for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(alive(childPid), false);
	});

	it("runs in the given working directory", async () => {
		const { ctx, lines } = context();
		await commandSource("pwd").start(ctx);
		const expected = execFileSync("bash", ["-c", "pwd -P"], { cwd: tmpdir(), encoding: "utf8" }).trim();
		assert.ok([tmpdir(), expected].includes(lines[0]!.text));
	});
});
