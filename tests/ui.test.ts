import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorMessageDetails } from "../src/delivery.ts";
import type { Registry } from "../src/registry.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { ANIM_MS, CLOCK_MS, SPIN_MS, UiController } from "../src/ui/controller.ts";
import type { DockItem } from "../src/ui/dock.ts";
import { ganttRows, MonitorsOverlay, type OverlayItem } from "../src/ui/overlay.ts";
import { renderMonitorMessage } from "../src/ui/renderer.ts";
import { monitorTitle, piTitle } from "../src/ui/title.ts";
import { harness } from "./harness.ts";
import { FakeClock, plainTheme, tagTheme, until } from "./helpers.ts";

const NOW = 1_700_000_400_000;

function item(partial: Partial<DockItem> & Pick<DockItem, "id" | "kind" | "status">): DockItem {
	return {
		description: partial.id,
		paused: false,
		startedAt: NOW - 60_000,
		progress: {},
		activity: [],
		handling: false,
		...partial,
	};
}

describe("terminal title", () => {
	it("shows a spinner and job progress while running", () => {
		const ci = item({
			id: "m1",
			kind: "gh_run",
			status: "running",
			progress: {
				title: "CI #42",
				jobs: [
					{ name: "a", state: "success" },
					{ name: "b", state: "success" },
					{ name: "c", state: "success" },
					{ name: "d", state: "running" },
					{ name: "e", state: "queued" },
				],
			},
		});
		assert.equal(monitorTitle([ci], NOW, 2, false), "⠹ pi · CI 3/5");
		assert.equal(monitorTitle([ci], NOW, 2, true), "◉ pi · CI 3/5");
	});

	it("leaves the title alone for commands on probation", () => {
		const probation = item({ id: "m1", kind: "command", status: "running", probationUntil: NOW + 5_000 });
		assert.equal(monitorTitle([probation], NOW, 0, false), undefined);
	});

	it("shows the result for a few seconds, then gives the title back", () => {
		const done = item({
			id: "m1",
			kind: "gh_run",
			status: "success",
			progress: { title: "CI #42" },
			endedAt: NOW - 1_000,
		});
		assert.equal(monitorTitle([done], NOW, 0, false), "✓ CI green");
		assert.equal(monitorTitle([{ ...done, status: "failure" }], NOW, 0, false), "✗ CI failed");
		assert.equal(monitorTitle([{ ...done, endedAt: NOW - 20_000 }], NOW, 0, false), undefined);
		assert.equal(piTitle("/home/me/app", undefined), "π - app");
		assert.equal(piTitle("/home/me/app", "fix ci"), "π - fix ci - app");
	});
});

describe("message renderer", () => {
	const details: MonitorMessageDetails = {
		id: "m3",
		description: "CI for PR #42",
		kind: "final",
		status: "failure",
		summary: "CI #42 failure after 6m12s: test",
	};
	const content = '[monitor m3 "CI for PR #42"] failed: CI #42 failure after 6m12s: test\nlog: /tmp/m3.log';

	it("shows one compact line when collapsed", () => {
		assert.equal(
			renderMonitorMessage(content, details, false, plainTheme),
			"✗ monitor m3 CI for PR #42 · CI #42 failure after 6m12s: test",
		);
	});

	it("shows what the model got when expanded", () => {
		const text = renderMonitorMessage(content, details, true, tagTheme);
		assert.match(text, /<error>✗<\/error>/);
		assert.match(text, /\n<toolOutput>log: \/tmp\/m3\.log<\/toolOutput>$/);
	});
});

describe("/monitors overlay", () => {
	const t0 = NOW - 300_000;
	const ci: OverlayItem = {
		...item({
			id: "m1",
			kind: "gh_run",
			status: "running",
			startedAt: t0,
			progress: {
				title: "CI #42",
				url: "https://github.com/acme/app/actions/runs/1",
				startedAt: t0,
				jobs: [
					{ name: "build", state: "success", startedAt: t0, completedAt: t0 + 60_000 },
					{ name: "test", state: "running", startedAt: t0 + 60_000 },
					{ name: "lint", state: "queued" },
				],
			},
		}),
		logPath: "/tmp/m1.log",
		log: { tail: ['» job "build" passed in 1m00s', '» job "test" started'] },
	};
	const dev: OverlayItem = {
		...item({ id: "m2", kind: "command", status: "running", description: "dev server", startedAt: NOW - 30_000 }),
		logPath: "/tmp/m2.log",
		log: { tail: Array.from({ length: 50 }, (_, i) => `request ${i}`) },
	};

	function overlay() {
		const calls: string[] = [];
		const component = new MonitorsOverlay(
			{
				items: () => [ci, dev],
				stop: (id) => calls.push(`stop ${id}`),
				open: (target) => calls.push(`open ${target}`),
				now: () => NOW,
				frame: () => 0,
				reducedMotion: () => false,
				savedTokens: () => 0,
				rows: () => 40,
				close: () => calls.push("close"),
				requestRender: () => {},
			},
			plainTheme,
		);
		return { component, calls };
	}

	it("draws a Gantt row per job on a shared time axis", () => {
		const rows = ganttRows(ci.progress.jobs!, t0, NOW, 40, plainTheme);
		assert.equal(rows.length, 3);
		assert.match(rows[0]!, /^build █{5} +1m00s$/);
		assert.match(rows[1]!, /^test {7}▓{21} +4m00s$/);
		assert.match(rows[2]!, /^lint {2}\s+$/);
	});

	it("lists monitors, the timeline and the log tail of the selected one", () => {
		const { component } = overlay();
		const lines = component.render(100).map((l) => stripTerminalSequences(l));
		for (const line of component.render(100)) assert.equal(visibleWidth(line), 100);
		const text = lines.join("\n");
		assert.match(lines[1]!, /│ › ⠋ CI #42/);
		assert.match(text, /├─ CI #42 · timeline/);
		assert.match(text, /├─ log · \/tmp\/m1\.log/);
		assert.match(text, /job "test" started/);
		assert.match(lines.at(-1)!, /↑↓ select · enter log · o open · s stop · esc close/);
	});

	it("moves the selection, opens the run in the browser and stops the selected monitor", () => {
		const { component, calls } = overlay();
		component.handleInput("o");
		component.handleInput("\x1b[B");
		component.handleInput("s");
		component.handleInput("o");
		assert.deepEqual(calls, ["open https://github.com/acme/app/actions/runs/1", "stop m2", "open /tmp/m2.log"]);
	});

	it("opens a scrollable log view with enter and goes back with escape", () => {
		const { component, calls } = overlay();
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		let text = component.render(100).join("\n");
		assert.match(text, /request 49/);
		component.handleInput("\x1b[5~");
		text = component.render(100).join("\n");
		assert.doesNotMatch(text, /request 49/);
		component.handleInput("\x1b");
		assert.deepEqual(calls, []);
		component.handleInput("\x1b");
		assert.deepEqual(calls, ["close"]);
	});
});

function uiStub() {
	const log: string[] = [];
	const widgets = new Map<string, unknown>();
	const ui = {
		theme: plainTheme,
		setWidget: (key: string, content: unknown) => {
			log.push(`widget ${key} ${content === undefined ? "off" : "on"}`);
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		setStatus: (key: string, text: string | undefined) => log.push(`status ${key} ${text ?? "off"}`),
		setTitle: (title: string) => log.push(`title ${title}`),
		notify: (text: string) => log.push(`notify ${text}`),
	};
	const render = (width: number) => {
		const factory = widgets.get("monitor") as
			((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
		return factory ? factory({ requestRender: () => {} }, plainTheme).render(width) : [];
	};
	return { ui, log, render };
}

describe("UI wiring", () => {
	function setup() {
		const clock = new FakeClock(NOW);
		const stub = uiStub();
		const notified: string[] = [];
		let internals: { registry: Registry; ui: UiController } | undefined;
		const h = harness({
			ui: stub.ui,
			overrides: { clock, notify: (title, body) => notified.push(`${title}: ${body}`), expose: (i) => (internals = i) },
		});
		return { h, clock, stub, notified, internals: () => internals! };
	}

	it("shows the dock while a monitor runs and removes everything when it is gone", async () => {
		const { h, clock, stub, notified, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		assert.equal(stub.log.length, 0, "nothing shows without monitors");
		assert.equal(internals().ui.animating, false);

		await h.call("monitor", { description: "build", command: "echo compiling; exit 1" });
		assert.ok(stub.log.includes("widget monitor on"));
		assert.equal(internals().ui.animating, true, "spinner runs while a monitor runs");
		assert.match(stub.render(100).join("\n"), /monitors/);
		assert.ok(stub.log.some((l) => l.startsWith("title ") && l.includes("pi · build")));

		await until(() => internals().registry.running().length === 0);
		assert.ok(stub.log.includes("title ✗ build failed"));
		assert.match(notified[0]!, /^pi · monitor: ✗ build: exited with code 1/);

		clock.advance(11_000);
		internals().ui.changed();
		assert.equal(stub.log.at(-2), "widget monitor off");
		assert.match(stub.log.at(-1)!, /^title π - /);
		assert.equal(internals().ui.animating, false, "no timer once nothing is visible");
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("keeps the full card while the agent works and never sets a footer status", async () => {
		const { h, stub } = setup();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "server", command: "sleep 30" });
		await h.fire("agent_start");
		await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
		await h.fire("message_update", { message: { role: "assistant" } });
		const lines = stub.render(120);
		assert.equal(lines.length, 3, "top border, one row, bottom border");
		assert.match(lines[0]!, /^╭─ monitors/);
		await h.fire("agent_settled");
		assert.deepEqual(stub.render(120), lines);
		assert.equal(stub.log.filter((l) => l.startsWith("status ")).length, 0);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("marks a monitor as handled from its message until the agent settles", async () => {
		const { h, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "server", command: "sleep 30" });
		await h.fire("message_start", { message: { role: "custom", customType: "monitor", details: { id: "m1" } } });
		assert.equal(internals().registry.get("m1")!.handling, true);
		await h.fire("agent_settled");
		assert.equal(internals().registry.get("m1")!.handling, false);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("stops timers and clears UI on session_shutdown", async () => {
		const { h, stub, internals } = setup();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "server", command: "sleep 30" });
		await h.fire("session_shutdown", { reason: "quit" });
		assert.equal(internals().ui.animating, false);
		assert.ok(stub.log.includes("widget monitor off"));
	});

	it("renders no UI in print mode but the tools still work", async () => {
		let internals: { ui: UiController } | undefined;
		const h = harness({ overrides: { expose: (i) => (internals = i) } });
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "quick", command: "true" });
		assert.equal(internals!.ui.attached, false);
		assert.equal(internals!.ui.animating, false);
		await until(() => h.sent.length > 0);
	});
});

describe("dock animation timer", () => {
	const richTheme = {
		...plainTheme,
		getColorMode: () => "truecolor" as const,
		appearance: "dark" as const,
		colors: { text: rgbColor(230, 232, 235) },
	};

	function controller(theme: object, reducedMotion = false) {
		const records = [item({ id: "m1", kind: "command", status: "running", description: "dev server" })];
		let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
		const ui = new UiController({
			registry: { visible: () => records, savedTokens: () => 0 } as unknown as Registry,
			settings: () => ({ ...DEFAULT_SETTINGS, reducedMotion }),
			now: () => NOW,
			sessionName: () => undefined,
			notify: () => {},
		});
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp/project",
			ui: {
				theme,
				setWidget: (_key: string, content: typeof factory) => (factory = content),
				setTitle: () => {},
			},
		};
		ui.attach(ctx as never);
		const render = (width: number) => factory!({ requestRender: () => {} }, theme).render(width);
		return { ui, render };
	}

	it("runs the colour dock at about 15 frames per second while something moves", () => {
		const { ui, render } = controller(richTheme);
		assert.equal(ui.interval, ANIM_MS);
		assert.ok(render(100)[0]!.includes("\x1b[38;2;"));
		ui.detach();
	});

	it("ticks once a second with reducedMotion, also with the colour dock", () => {
		const { ui } = controller(richTheme, true);
		assert.equal(ui.interval, CLOCK_MS);
		ui.detach();
	});

	it("keeps the plain spinner speed and rendering for themes without a colour mode", () => {
		const { ui, render } = controller(plainTheme);
		assert.equal(ui.interval, SPIN_MS);
		assert.ok(!render(100).join("\n").includes("\x1b["));
		ui.detach();
	});
});
