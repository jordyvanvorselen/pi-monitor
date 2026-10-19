import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { abortableSleep, defaultRun } from "../src/exec.ts";
import { fileSource } from "../src/sources/file.ts";
import { pidSource } from "../src/sources/pid.ts";
import type { SourceContext } from "../src/sources/types.ts";
import { urlDelay, urlSource } from "../src/sources/url.ts";
import { until } from "./helpers.ts";

function context(fakeTime = false) {
	let time = 0;
	const lines: string[] = [];
	const controller = new AbortController();
	const ctx: SourceContext = {
		signal: controller.signal,
		cwd: tmpdir(),
		run: defaultRun,
		now: () => (fakeTime ? time : Date.now()),
		sleep: fakeTime
			? async (ms) => {
					time += ms;
				}
			: (ms) => abortableSleep(ms, controller.signal),
		emit: () => {},
		line: (text) => lines.push(text),
		update: () => {},
	};
	return { ctx, lines, controller };
}

describe("file source", () => {
	it("tails only new lines, keeps partial lines until complete and survives truncation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-monitor-file-"));
		const path = join(dir, "app.log");
		writeFileSync(path, "old line\n");
		const { ctx, lines, controller } = context();
		const running = fileSource(path).start(ctx);
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, "first\nsec");
		await until(() => lines.includes("first"));
		appendFileSync(path, "ond\n");
		await until(() => lines.includes("second"));
		writeFileSync(path, "after truncate\n");
		await until(() => lines.includes("after truncate"));
		controller.abort();
		assert.equal((await running).status, "stopped");
		assert.deepEqual(lines, ["first", "second", "after truncate"]);
	});

	it("waits for a file that does not exist yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-monitor-file-"));
		const path = join(dir, "later.log");
		const { ctx, lines, controller } = context();
		const running = fileSource(path).start(ctx);
		await new Promise((r) => setTimeout(r, 50));
		writeFileSync(path, "hello\n");
		await until(() => lines.includes("hello"));
		controller.abort();
		await running;
	});
});

describe("url source", () => {
	it("backs off from 2 s to 5 s to 10 s", () => {
		assert.deepEqual([urlDelay(0), urlDelay(60_000), urlDelay(300_000)], [2_000, 5_000, 10_000]);
	});

	it("reports status changes once and succeeds on 2xx", async () => {
		const answers = [503, 503, 502, 200];
		const source = urlSource("http://localhost:3000/health", async () => ({ status: answers.shift()! }));
		const { ctx, lines } = context(true);
		const outcome = await source.start(ctx);
		assert.equal(outcome.status, "success");
		assert.match(outcome.summary, /answered 200 after 6s$/);
		assert.deepEqual(lines, ["HTTP 503", "HTTP 502"]);
	});

	it("treats connection errors as not ready yet", async () => {
		let calls = 0;
		const source = urlSource("http://localhost:1/", async () => {
			if (calls++ < 2) throw new TypeError("fetch failed");
			return { status: 204 };
		});
		const { ctx, lines } = context(true);
		assert.equal((await source.start(ctx)).status, "success");
		assert.deepEqual(lines, ["connection failed"]);
	});

	it("rejects invalid URLs when the monitor starts", () => {
		assert.throws(() => urlSource("not a url"), /not a valid URL/);
	});
});

describe("pid source", () => {
	it("succeeds once the process is gone", async () => {
		let checks = 0;
		const source = pidSource(4242, () => checks++ < 3);
		const outcome = await source.start(context(true).ctx);
		assert.deepEqual(outcome, { status: "success", summary: "process 4242 exited after 3s" });
	});

	it("fails when no such process runs at the start", async () => {
		const outcome = await pidSource(4242, () => false).start(context(true).ctx);
		assert.equal(outcome.status, "failure");
	});

	it("rejects pids that are not positive integers", () => {
		assert.throws(() => pidSource(-1), /positive integer/);
	});
});
