import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Interceptor } from "../src/intercept/index.ts";
import { lastAssistantText } from "../src/intercept/index.ts";
import { readMarker } from "../src/intercept/rewrite.ts";
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
		assert.deepEqual(readMarker(input.command), { id: "m1", command: "gh run watch 123 --exit-status" });
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
		assert.match(suspect.input.command, /# pi-monitor: \{"id":"m1"/);
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
	type Renderers = {
		renderCall: (
			args: unknown,
			theme: unknown,
			context: { toolCallId: string },
		) => { text?: string; setText?: unknown };
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

	function resolver(h: ReturnType<typeof harness>) {
		const resolve = h.renderers["tool"] as (name: string, next: () => unknown) => Renderers | undefined;
		const base = {
			renderCall: (args: { command: string }) => {
				const component = { text: `$ ${args.command}`, setText: (t: string) => (component.text = t) };
				return component;
			},
		};
		return { bash: resolve("bash", () => base)!, other: resolve("read", () => "read renderers") };
	}

	it("shows the original command and the monitor id for rewritten calls", async () => {
		const { h, bash } = setup();
		await h.fire("session_start", { reason: "startup" });
		const { input, toolCallId } = await bash("gh run watch 7");
		const { bash: renderers, other } = resolver(h);
		const shown = renderers.renderCall(input, theme, { toolCallId });
		assert.equal(shown.text, "$ gh run watch 7  → monitor m1");
		const afterRestart = renderers.renderCall(input, theme, { toolCallId: "unknown" });
		assert.equal(afterRestart.text, "$ gh run watch 7  → monitor m1", "the marker works without the map");
		assert.equal(renderers.renderCall({ command: "ls" }, theme, { toolCallId: "x" }).text, "$ ls");
		assert.equal(other, "read renderers");
		await h.fire("session_shutdown", { reason: "quit" });
	});
});

describe("stopping from /monitors", () => {
	it("tells the model on its next turn without waking it", async () => {
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
		assert.deepEqual(sent.options, { deliverAs: "nextTurn" });
		assert.match(sent.message.content, /\[monitor m1 "server"\] stopped by the user\./);
		await h.fire("session_shutdown", { reason: "quit" });
	});
});
