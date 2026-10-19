import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DockComponent, renderDock, type DockItem, type DockOptions } from "../src/ui/dock.ts";
import { etaBar, jobTrack, sparkline } from "../src/ui/glyphs.ts";
import type { Job } from "../src/sources/types.ts";
import { plainTheme, tagTheme } from "./helpers.ts";

const NOW = 1_700_000_400_000;
const bucket = (ago: number) => Math.floor((NOW - ago) / 10_000);

function item(partial: Partial<DockItem> & Pick<DockItem, "id" | "kind" | "status">): DockItem {
	return {
		description: partial.id,
		paused: false,
		startedAt: NOW - 250_000,
		progress: {},
		activity: [],
		handling: false,
		...partial,
	};
}

const jobs: Job[] = [
	{ name: "build", state: "success" },
	{ name: "lint", state: "success" },
	{ name: "test", state: "running", step: "Run unit tests" },
	{ name: "e2e", state: "queued" },
	{ name: "deploy", state: "queued" },
];

const ci = item({
	id: "m1",
	kind: "gh_run",
	status: "running",
	description: "CI for PR #42",
	progress: { title: "CI #42", url: "https://github.com/acme/app/actions/runs/1", jobs, etaMs: 360_000 },
});
const devServer = item({
	id: "m2",
	kind: "command",
	status: "running",
	description: "dev server",
	startedAt: NOW - 600_000,
	lastLine: "GET /api/users 200 in 12ms",
	lastLineAt: NOW - 12_000,
	activity: [
		{ bucket: bucket(30_000), count: 2 },
		{ bucket: bucket(20_000), count: 9 },
		{ bucket: bucket(0), count: 5 },
	],
});

function options(partial: Partial<DockOptions> = {}): DockOptions {
	return {
		width: 120,
		now: NOW,
		frame: 2,
		mode: "card",
		streaming: false,
		savedTokens: 6_200,
		shortcut: "ctrl+shift+m",
		reducedMotion: false,
		...partial,
	};
}

const plain = (lines: string[]) => lines.map((l) => stripTerminalSequences(l));

describe("dock glyphs", () => {
	it("draws a job track with solid links after finished jobs", () => {
		assert.equal(jobTrack(jobs, plainTheme), "●━━●━━◐┄┄○┄┄○");
		assert.equal(
			jobTrack(
				[
					{ name: "a", state: "failure" },
					{ name: "b", state: "skipped" },
				],
				tagTheme,
			),
			"<error>✗</error><muted>━━</muted><dim>◌</dim>",
		);
	});

	it("falls back to a count when the track does not fit", () => {
		const many: Job[] = Array.from({ length: 30 }, (_, i) => ({ name: `j${i}`, state: i < 12 ? "success" : "queued" }));
		assert.equal(jobTrack(many, plainTheme, 40), "12/30");
	});

	it("shows an ETA bar with time left, and overtime as a warning", () => {
		assert.equal(etaBar(180_000, 360_000, plainTheme), "▰▰▰▱▱ ~3m");
		assert.equal(etaBar(420_000, 360_000, tagTheme).endsWith("<warning>+1m</warning>"), true);
	});

	it("draws an activity sparkline with the newest bucket on the right", () => {
		assert.equal(sparkline(devServer.activity, NOW, plainTheme, 4), "▃█▁▅");
	});
});

describe("dock card", () => {
	it("renders a rounded card with title, summary, rows and the shortcut hint", () => {
		const lines = plain(renderDock([ci, devServer], options(), plainTheme));
		assert.equal(lines.length, 4);
		assert.match(lines[0]!, /^╭─ monitors ─+ 2 running · saved ~6\.2k tok ─╮$/);
		assert.match(lines[1]!, /^│ ⠹ dev server {2}▁▁▁▁▃█▁▅ {2}last: GET \/api\/users 200 in 12ms · 12s ago +10m00s │$/);
		assert.match(lines[2]!, /^│ ⠹ CI #42 {2}●━━●━━◐┄┄○┄┄○ {2}test ▸ Run unit tests +▰▰▰▱▱ ~1m {2}4m10s │$/);
		assert.match(lines[3]!, /^╰─+ ctrl\+shift\+m view · \/monitors ─╯$/);
	});

	it("keeps every line exactly as wide as the terminal at several widths", () => {
		for (const width of [160, 120, 88, 80, 60, 50, 40, 30]) {
			for (const line of renderDock([ci, devServer], options({ width }), plainTheme))
				assert.equal(visibleWidth(line), width, `width ${width}: ${line}`);
		}
	});

	it("links the run name to GitHub with OSC 8", () => {
		const row = renderDock([ci], options(), plainTheme)[1]!;
		assert.ok(row.includes("\x1b]8;;https://github.com/acme/app/actions/runs/1\x1b\\CI #42"));
	});

	it("drops sparkline and ETA at medium width", () => {
		const lines = plain(renderDock([ci, devServer], options({ width: 80 }), plainTheme));
		assert.doesNotMatch(lines.join("\n"), /▰|▁▁/);
		assert.match(lines[2]!, /CI #42 {2}●━━●━━◐┄┄○┄┄○ {2}test ▸ Run unit tests +4m10s │$/);
	});

	it("uses compact rows at narrow width", () => {
		const lines = plain(renderDock([ci, devServer], options({ width: 50 }), plainTheme));
		assert.match(lines[2]!, /^│ ⠹ CI #42 2\/5 4m +│$/);
		assert.match(lines[1]!, /^│ ⠹ dev server 10m +│$/);
	});

	it("marks quiet commands with a warning age", () => {
		const quiet = { ...devServer, lastLineAt: NOW - 7 * 60_000 };
		// Wide enough for the color tags, which count as visible text.
		const row = renderDock([quiet], options({ width: 400 }), tagTheme)[1]!;
		assert.match(row, /<warning>quiet 7m<\/warning>/);
	});

	it("shows pi is on it while the model handles an event", () => {
		const row = plain(renderDock([{ ...devServer, handling: true }], options(), plainTheme))[1]!;
		assert.match(row, /pi is on it ↳ {2}10m00s │$/);
	});

	it("flashes a finished row, then collapses it, then hides it", () => {
		const done = item({
			id: "m1",
			kind: "gh_run",
			status: "success",
			progress: { title: "CI #42" },
			endedAt: NOW - 500,
			summary: "CI #42 green in 6m02s",
		});
		const flash = renderDock([done], options(), tagTheme)[1]!;
		assert.match(flash, /<b><success>✓ CI #42 green in 6m02s<\/success><\/b>/);
		const collapsed = renderDock([{ ...done, endedAt: NOW - 3_000 }], options(), tagTheme)[1]!;
		assert.match(collapsed, /<success>✓<\/success> <muted>CI #42 green in 6m02s<\/muted>/);
		assert.deepEqual(renderDock([{ ...done, endedAt: NOW - 11_000 }], options(), tagTheme), []);
	});

	it("shows why a monitor stopped in its collapsed row", () => {
		const stopped = item({
			id: "m2",
			kind: "command",
			status: "stopped",
			description: "dev server",
			endedAt: NOW - 3_000,
			summary: "stopped by the user after 1m41s",
		});
		assert.match(
			plain(renderDock([stopped], options(), plainTheme))[1]!,
			/│ ■ dev server stopped by the user after 1m41s +│/,
		);
	});

	it("does not flash with reducedMotion and shows no spinner", () => {
		const done = item({ id: "m9", kind: "command", status: "failure", endedAt: NOW - 500, summary: "exited 1" });
		const lines = renderDock([done, devServer], options({ reducedMotion: true }), tagTheme);
		assert.doesNotMatch(lines.join("\n"), /<b><error>/);
		assert.match(lines.join("\n"), /◉/);
		assert.doesNotMatch(lines.join("\n"), /⠹/);
	});

	it("puts failures first and folds more than four rows into +N more", () => {
		const failed = item({ id: "bad", kind: "command", status: "failure", endedAt: NOW - 2_000, summary: "exit 1" });
		const extra = [1, 2, 3, 4].map((n) => item({ id: `run${n}`, kind: "command", status: "running" }));
		const lines = plain(renderDock([...extra, failed], options(), plainTheme));
		assert.equal(lines.length, 6);
		assert.match(lines[1]!, /✗ bad exit 1/);
		assert.match(lines[4]!, /\+2 more · \/monitors/);
		assert.match(lines[0]!, /4 running · 1 failed/);
	});

	it("hides entirely when there are no monitors", () => {
		assert.deepEqual(renderDock([], options(), plainTheme), []);
	});
});

describe("dock line mode", () => {
	it("folds to one line while the agent streams", () => {
		const failed = item({ id: "e2e", kind: "command", status: "failure", endedAt: NOW - 2_000, summary: "exit 1" });
		const lines = plain(renderDock([ci, failed], options({ streaming: true }), plainTheme));
		assert.deepEqual(lines, ["◉ 2 monitors · e2e ✗ · CI #42 2/5"]);
	});

	it("uses the line mode when chosen", () => {
		assert.equal(renderDock([ci], options({ mode: "line" }), plainTheme).length, 1);
	});
});

describe("dock component", () => {
	it("caches lines per width until invalidated", () => {
		let draws = 0;
		const component = new DockComponent((width) => {
			draws++;
			return [`w${width}`];
		});
		component.render(80);
		component.render(80);
		assert.equal(draws, 1);
		component.render(100);
		assert.equal(draws, 2);
		component.invalidate();
		component.render(100);
		assert.equal(draws, 3);
	});
});
