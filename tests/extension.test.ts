import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { harness } from "./harness.ts";
import { until } from "./helpers.ts";

describe("extension wiring", () => {
	it("teaches the model through promptSnippet and promptGuidelines instead of the system prompt", () => {
		const h = harness();
		const tool = h.tools.monitor!;
		assert.ok(tool.promptSnippet);
		assert.ok(tool.promptGuidelines && tool.promptGuidelines.length >= 1 && tool.promptGuidelines.length <= 3);
		assert.match(tool.promptGuidelines.join(" "), /moves them to the background/);
	});

	it("starts a command monitor, answers at once and reports the end", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		const started = Date.now();
		const result = await h.call("monitor", { description: "echo test", command: "echo hello; exit 2" });
		assert.ok(Date.now() - started < 500);
		assert.match(result.content[0]!.text, /^Started m1 "echo test" \(echo hello; exit 2\)\. You will be notified/);
		await until(() => h.sent.some((s) => s.message.details.kind === "final"));
		const final = h.sent.find((s) => s.message.details.kind === "final")!;
		assert.match(final.message.content, /^\[monitor m1 "echo test"\] failed: exited with code 2/);
		assert.deepEqual(final.options, { triggerTurn: true });
		const logPath = String(result.details.logPath);
		assert.ok(existsSync(logPath));
		assert.match(readFileSync(logPath, "utf8"), /hello/);
	});

	it("stores cwd and the reporting mode in the spec of tool-started monitors, like intercepted ones", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "build", command: "true", wake: "final" });
		await h.call("monitor", { description: "server", command: "true" });
		await h.call("monitor", { description: "this process", pid: process.pid });
		const specs = h.entries.filter((e) => e.data.kind === "start").map((e) => e.data.spec as Record<string, unknown>);
		assert.deepEqual(
			specs.map((s) => [s.description, s.cwd, s.reportOutput]),
			[
				["build", h.cwd, true],
				["server", h.cwd, false],
				["this process", h.cwd, false],
			],
		);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("records start and end entries for resume", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "quick", command: "true" });
		await until(() => h.entries.some((e) => e.data.kind === "end"));
		assert.deepEqual(
			h.entries.map((e) => [e.customType, e.data.kind]),
			[
				["monitor-state", "start"],
				["monitor-state", "end"],
			],
		);
	});

	it("rejects calls without exactly one source", async () => {
		const h = harness();
		await assert.rejects(h.call("monitor", { description: "x" }), /exactly one source/);
		await assert.rejects(h.call("monitor", { description: "x", command: "true", url: "http://x" }), /Got command, url/);
	});

	it("rejects an invalid match regex", async () => {
		const h = harness();
		await assert.rejects(h.call("monitor", { description: "x", command: "true", match: "(" }), /not a valid regex/);
	});

	it('mentions gh_run "next" in the tool schema so the model can wait for CI that has not started', () => {
		const h = harness();
		const schema = JSON.stringify((h.tools.monitor as unknown as { parameters: unknown }).parameters);
		assert.match(schema, /\\"next\\" \(waits for the next run on the branch/);
	});

	it("stores branch and workflow for gh_run and rejects them for other sources", async () => {
		const h = harness({
			overrides: { run: async () => ({ stdout: "[]", stderr: "", code: 0 }) },
		});
		await h.fire("session_start", { reason: "startup" });
		const started = await h.call("monitor", { description: "CI", gh_run: "next", branch: "main", workflow: "ci.yml" });
		assert.match(started.content[0]!.text, /^Started m1 "CI" \(next gh run on main\)/);
		const spec = h.entries.find((e) => e.data.kind === "start")!.data.spec as Record<string, unknown>;
		assert.deepEqual([spec.target, spec.branch, spec.workflow], ["next", "main", "ci.yml"]);
		await assert.rejects(
			h.call("monitor", { description: "x", command: "true", branch: "main" }),
			/only apply to gh_run/,
		);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("accepts a numeric gh_run id and a string pid", async () => {
		const h = harness();
		const prepare = h.tools.monitor!.prepareArguments!;
		assert.deepEqual(prepare({ description: "x", gh_run: 123 }), { description: "x", gh_run: "123" });
		assert.deepEqual(prepare({ description: "x", pid: "42" }), { description: "x", pid: 42 });
	});

	it("stops a monitor quietly with monitor_stop", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "long", command: "sleep 30" });
		const stopped = await h.call("monitor_stop", { id: "m1" });
		assert.equal(stopped.content[0]!.text, "Stopped m1.");
		await until(() => h.entries.some((e) => e.data.kind === "end"));
		assert.equal(h.sent.length, 0, "a stop the model asked for does not wake it");
		await assert.rejects(h.call("monitor_stop", { id: "m1" }), /No running monitor m1\. Running: none\./);
	});

	it("enforces maxConcurrent from settings", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		for (let i = 0; i < 5; i++) await h.call("monitor", { description: `s${i}`, command: "sleep 30" });
		await assert.rejects(h.call("monitor", { description: "one too many", command: "sleep 30" }), /Too many monitors/);
		const stopped = await h.call("monitor_stop", { id: "all" });
		assert.equal(stopped.content[0]!.text, "Stopped 5 monitors.");
	});

	it("filters stdout and stderr through match", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", {
			description: "errors",
			command: "echo ok; echo 'ERROR one' >&2; echo fine; echo 'ERROR two'",
			match: "ERROR",
		});
		await until(() => h.sent.some((s) => s.message.details.kind === "final"));
		const events = h.sent.filter((s) => s.message.details.kind === "event").map((s) => s.message.content);
		const all = events.join("\n");
		assert.match(all, /ERROR one/);
		assert.match(all, /ERROR two/);
		assert.doesNotMatch(all, /\bok\b|fine/);
	});

	it("kills running commands on session_shutdown", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "long", command: "sleep 30" });
		await h.fire("session_shutdown", { reason: "quit" });
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(h.sent.length, 0);
	});
});
