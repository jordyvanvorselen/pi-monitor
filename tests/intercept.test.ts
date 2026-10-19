import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Interceptor } from "../src/intercept/index.ts";
import { lastAssistantText, timeoutMinutes } from "../src/intercept/index.ts";
import type { Registry } from "../src/registry.ts";
import { harness } from "./harness.ts";
import { plainTheme, until } from "./helpers.ts";
import { fakeClassifierRegistry } from "./triage.test.ts";

const ui = {
	theme: plainTheme,
	setWidget: () => {},
	setStatus: () => {},
	setTitle: () => {},
	notify: () => {},
};

function setup(options: { modelRegistry?: unknown; env?: NodeJS.ProcessEnv; ui?: unknown; settings?: object } = {}) {
	let internals: { registry: Registry; interceptor: Interceptor } | undefined;
	const h = harness({
		ui: "ui" in options ? options.ui : ui,
		modelRegistry: options.modelRegistry,
		overrides: {
			env: options.env ?? {},
			expose: (i) => (internals = i),
			run: async () => ({ stdout: "", stderr: "HTTP 502", code: 1 }),
		},
	});
	if (options.settings) {
		mkdirSync(join(h.cwd, ".pi"), { recursive: true });
		writeFileSync(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ monitor: options.settings }));
	}
	let n = 0;
	const bash = async (command: string, timeout?: number) => {
		const input: { command: string; timeout?: number } = { command, ...(timeout ? { timeout } : {}) };
		const toolCallId = `call-${++n}`;
		await h.fire("tool_call", { toolName: "bash", toolCallId, input });
		return { input, toolCallId };
	};
	return { h, bash, internals: () => internals! };
}

/** Run a rewritten command like the bash tool would, without blocking the event loop. */
const sh = (command: string) =>
	new Promise<string>((resolve) =>
		execFile("bash", ["-c", command], { encoding: "utf8" }, (_e, stdout) => resolve(stdout)),
	);

describe("bash interceptor", () => {
	it("turns gh run watch into a gh_run monitor and a harmless printf", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("gh run watch 123 --exit-status");
		assert.equal(
			await sh(input.command),
			"Running in background as m1 (gh run watch 123 --exit-status). You will be notified when it ends.\n",
		);
		const record = internals().registry.get("m1")!;
		assert.equal(record.kind, "gh_run");
		assert.equal(record.spec.target, "123");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("turns sleep N && X into a timer that reports X's output", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("sleep 21 && echo done");
		assert.match(await sh(input.command), /^Running in background as m1/);
		const record = internals().registry.get("m1")!;
		assert.deepEqual(
			[record.kind, record.spec.target, record.wake, record.spec.reportOutput],
			["command", "sleep 21 && echo done", "final", true],
		);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("uses the model's bash timeout as the monitor timeout", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		await bash("sleep 45 && echo done", 120);
		assert.equal(internals().registry.get("m1")!.spec.timeoutMinutes, 2);
		await bash("gh run watch 9", 600);
		assert.equal(internals().registry.get("m2")!.spec.timeoutMinutes, 10);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("never lets a bash timeout end a timer before its sleep is over", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		await bash("sleep 45 && echo done", 30);
		assert.equal(internals().registry.get("m1")!.spec.timeoutMinutes, 1);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("keeps the estimate when the model gives no bash timeout", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		await bash("sleep 45 && echo done");
		assert.equal(internals().registry.get("m1")!.spec.timeoutMinutes, 31);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("computes monitor timeouts from the bash timeout, a floor and a fallback", () => {
		assert.equal(timeoutMinutes(31, 120, 60), 2);
		assert.equal(timeoutMinutes(31, 10, 60), 1);
		assert.equal(timeoutMinutes(31), 31);
		assert.equal(timeoutMinutes(31, 999_999), 240);
	});

	it("turns tail -f | grep into a file monitor with match", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("tail -f app.log | grep --line-buffered ERROR");
		assert.match(await sh(input.command), /You will be notified of new lines\./);
		const record = internals().registry.get("m1")!;
		assert.deepEqual(
			[record.kind, record.spec.target, record.spec.match, record.wake],
			["file", "app.log", "ERROR", "events"],
		);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("leaves obviously short commands untouched without asking a classifier", async () => {
		const fake = fakeClassifierRegistry(() => ({ choice: "background" }));
		const { h, bash } = setup({ modelRegistry: fake.registry });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("git status && ls");
		assert.equal(input.command, "git status && ls");
		assert.equal(fake.calls.length, 0);
	});

	it("starts a background monitor when the classifier says background", async () => {
		const fake = fakeClassifierRegistry(() => ({ choice: "background" }));
		const { h, bash, internals } = setup({ modelRegistry: fake.registry });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("npm run dev");
		assert.match(await sh(input.command), /^Running in background as m1 \(npm run dev\)/);
		assert.equal(internals().registry.get("m1")!.wake, "final");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("runs normally when the classifier says short", async () => {
		const fake = fakeClassifierRegistry(() => ({ choice: "short" }));
		const { h, bash } = setup({ modelRegistry: fake.registry });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("npm run dev");
		assert.equal(input.command, "npm run dev");
	});

	it("uses the safety net when the classifier is unsure", async () => {
		const fake = fakeClassifierRegistry(() => ({ choice: "unsure" }));
		const { h, bash, internals } = setup({ modelRegistry: fake.registry, settings: { backgroundAfterSeconds: 1 } });
		await h.fire("session_start", { reason: "startup" });
		const { input, toolCallId } = await bash("sh -c 'echo quick'", 60);
		assert.match(input.command, /while \[ ! -s "\$s" \]/);
		assert.equal(await sh(input.command), "quick\n");
		await h.fire("tool_result", { toolName: "bash", toolCallId, input, content: [], isError: false });
		await until(() => internals().registry.get("m1") === undefined);
	});

	it("falls back to a keyword guess without a classifier", async () => {
		const { h, bash } = setup();
		await h.fire("session_start", { reason: "startup" });
		const plain = await bash("make build");
		assert.equal(plain.input.command, "make build");
		const suspect = await bash("sh -c 'echo pretend deploy'");
		assert.notEqual(suspect.input.command, "sh -c 'echo pretend deploy'");
		assert.equal(await sh(suspect.input.command), "pretend deploy\n");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("does nothing in print mode, where no later turn would receive the result", async () => {
		const { h, bash } = setup({ ui: undefined });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("gh run watch 1");
		assert.equal(input.command, "gh run watch 1");
	});

	it("does nothing with PI_MONITOR_INTERCEPT=0", async () => {
		const { h, bash } = setup({ env: { PI_MONITOR_INTERCEPT: "0" } });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("gh run watch 1");
		assert.equal(input.command, "gh run watch 1");
	});

	it("fails open: when a monitor cannot start the command runs unchanged", async () => {
		const { h, bash } = setup({ settings: { maxConcurrent: 1 } });
		await h.fire("session_start", { reason: "startup" });
		await bash("gh run watch 1");
		const { input } = await bash("gh run watch 2");
		assert.equal(input.command, "gh run watch 2");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("ignores other tools and commands it already rewrote", async () => {
		const { h, bash } = setup();
		await h.fire("session_start", { reason: "startup" });
		const input = { path: "x" };
		await h.fire("tool_call", { toolName: "read", toolCallId: "r", input });
		assert.deepEqual(input, { path: "x" });
		const first = await bash("gh run watch 1");
		const again = { command: first.input.command };
		await h.fire("tool_call", { toolName: "bash", toolCallId: "again", input: again });
		assert.equal(again.command, first.input.command);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("finds the last assistant text on the branch", () => {
		assert.equal(
			lastAssistantText([
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
				{ type: "message", message: { role: "user", content: "hi" } },
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Starting the dev server." }] },
				},
				{ type: "custom" },
			]),
			"Starting the dev server.",
		);
	});
});

describe("bash transcript renderer", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	type Result = { render(width: number): string[] };
	type Renderers = {
		renderCall?: unknown;
		renderResult: (result: unknown, options: unknown, theme: unknown, context: object) => Result;
	};

	function resolve(h: ReturnType<typeof harness>, toolName = "bash") {
		const resolver = h.renderers["tool"] as (name: string, next: () => unknown) => Renderers | undefined;
		const base = {
			renderCall: "default call renderer",
			renderResult: (result: { text: string }, _o: unknown, _t: unknown, context: { lastComponent?: Result }) =>
				context.lastComponent ?? { render: () => [result.text] },
		};
		return resolver(toolName, () => base)!;
	}

	it("keeps Pi's own call rendering, because Pi shows the original command", async () => {
		const { h } = setup();
		assert.equal(resolve(h).renderCall, "default call renderer");
	});

	it("tags the result of an intercepted call with its monitor while that monitor runs", async () => {
		const { h, bash, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		const { toolCallId } = await bash("gh run watch 7");
		const renderers = resolve(h);
		const first = renderers.renderResult({ text: "Running in background as m1" }, {}, theme, { toolCallId });
		assert.deepEqual(first.render(80), ["Running in background as m1", "→ monitor m1"]);
		const again = renderers.renderResult({ text: "x" }, {}, theme, { toolCallId, lastComponent: first });
		assert.equal(again, first, "re-renders reuse the component");

		internals().registry.stop("m1", "user");
		await until(() => internals().registry.get("m1")!.status !== "running");
		const ended = renderers.renderResult({ text: "done" }, {}, theme, { toolCallId, lastComponent: first });
		assert.deepEqual(ended.render(80), ["Running in background as m1"], "no tag once the monitor ended");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("leaves other bash calls and other tools to the next renderer", async () => {
		const { h } = setup();
		const plain = resolve(h).renderResult({ text: "ls output" }, {}, theme, { toolCallId: "other" });
		assert.deepEqual(plain.render(80), ["ls output"]);
		const resolver = h.renderers["tool"] as (name: string, next: () => unknown) => unknown;
		assert.equal(
			resolver("read", () => "read renderers"),
			"read renderers",
		);
	});
});

describe("result text tells the model what happened", () => {
	const namesMonitorInBackground = (text: string) => {
		assert.match(text, /\bm\d+\b/, `names the monitor id: ${text}`);
		assert.match(text, /background/i, `says it runs in the background: ${text}`);
		assert.doesNotMatch(text, /pi-monitor:|^#/m, `no marker or comment lines: ${text}`);
	};

	for (const command of [
		"gh run watch 123",
		"gh pr checks 42 --watch",
		"sleep 30 && echo done",
		"tail -f app.log | grep --line-buffered ERROR",
	]) {
		it(`a rewritten "${command}" result names the monitor and says it runs in the background`, async () => {
			const { h, bash } = setup();
			await h.fire("session_start", { reason: "startup" });
			const { input } = await bash(command);
			namesMonitorInBackground(await sh(input.command));
			await h.fire("session_shutdown", { reason: "quit" });
		});
	}

	it("a classifier-backgrounded result names the monitor and says it runs in the background", async () => {
		const fake = fakeClassifierRegistry(() => ({ choice: "background" }));
		const { h, bash } = setup({ modelRegistry: fake.registry });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("npm run dev");
		namesMonitorInBackground(await sh(input.command));
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("a safety-net result for a command still running names the monitor and says it moved to the background", async () => {
		const { h, bash } = setup({ settings: { backgroundAfterSeconds: 1 } });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("sh -c 'echo listening; sleep 5' # dev server");
		const text = await sh(input.command);
		assert.match(text, /^listening\nStill running after 1s\. Moved to background as m1 /);
		namesMonitorInBackground(text.split("\n")[1]!);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("a safety-net result for a command that ended in time is just its output", async () => {
		const { h, bash } = setup({ settings: { backgroundAfterSeconds: 5 } });
		await h.fire("session_start", { reason: "startup" });
		const { input } = await bash("sh -c 'echo built' # deploy");
		assert.equal(await sh(input.command), "built\n");
	});
});

describe("stopping from /monitors", () => {
	it("queues a non-triggering note that names the monitor and says the user stopped it", async () => {
		let overlay: { handleInput(data: string): void } | undefined;
		const custom = async (factory: (...args: unknown[]) => { handleInput(data: string): void }) => {
			overlay = factory({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, {}, () => {});
		};
		const { h } = setup({ ui: { ...ui, custom } });
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "server", command: "sleep 30" });
		await h.commands["monitors"]!("", h.ctx);
		overlay!.handleInput("s");
		const sent = h.sent.at(-1)!;
		assert.deepEqual(sent.options, { deliverAs: "nextTurn" }, "queued for the next turn, no triggerTurn");
		assert.match(sent.message.content, /^\[monitor m1 "server"\] stopped by the user\.$/);
		await until(() => h.entries.some((e) => e.data.kind === "end"));
		const ended = h.entries.find((e) => e.data.kind === "end")!.data;
		assert.equal(ended.reason, "user");
		assert.match(String(ended.summary), /^stopped by the user after/);
		await h.fire("session_shutdown", { reason: "quit" });
	});
});
