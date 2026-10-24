import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { paletteFor } from "../src/herdr/integration.ts";
import { MIN_INTERVAL_MS } from "../src/herdr/sidebar.ts";
import { sidebarTokens } from "../src/herdr/tokens.ts";
import { hex } from "../src/ui/color.ts";
import { story } from "../scripts/dock-story.ts";
import {
	LOOP_MS,
	sceneAt,
	shiftItem,
	simulate,
	STEP_MS,
	T0,
	VirtualClock,
	type Timeline,
} from "../scripts/herdr-story.ts";
import { ansiCells, COLS, renderHerdr, ROWS, SIDEBAR } from "../scripts/herdr-view.ts";
import { piTheme } from "../scripts/pi-theme.ts";

let timeline: Timeline;
before(async () => {
	timeline = await simulate();
});

const tokens = (ms: number, pane: string) => sceneAt(timeline, ms).agents.find((a) => a.pane === pane)!.tokens;
const state = (ms: number, pane: string) => sceneAt(timeline, ms).agents.find((a) => a.pane === pane)!.state;

describe("README Herdr recording story", () => {
	it("sends each pane's tokens at most once a second, because that is all pi sends Herdr", () => {
		for (const pane of ["webapp", "backend"]) {
			const times = timeline.reports.filter((r) => r.pane === pane).map((r) => r.at);
			assert.ok(times.length > 5, pane);
			for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= MIN_INTERVAL_MS, `${pane} ${i}`);
		}
	});

	it("shows the beats the README promises in the sidebar rows", () => {
		assert.match(tokens(2_500, "webapp").mon!, /^◐ CI #42 ▰+▱+ 2\/4 · 4m$/);
		assert.deepEqual([tokens(2_500, "webapp").mon_run, tokens(2_500, "webapp").mon_wait], ["◐2", "⏳1"]);
		assert.equal(tokens(6_500, "webapp").mon, "✗ CI #42 test failed");
		assert.equal(tokens(6_500, "webapp").mon_fail, "✗1");
		assert.equal(tokens(10_000, "backend").mon, "✗ e2e #17 checkout failed");
		assert.equal(tokens(14_500, "webapp").mon, "✓ CI #42 green in 6m02s");
		assert.equal(tokens(14_500, "webapp").mon_ok, "✓1");
	});

	it("drops the counts row before the loop ends, once only the dev server is left", () => {
		assert.equal(tokens(LOOP_MS - STEP_MS, "webapp").mon, "◐ dev server · 2h14");
		assert.equal(tokens(LOOP_MS - STEP_MS, "webapp").mon_run, null);
	});

	it("toasts with the text HerdrIntegration sends when a monitor ends, and only then", () => {
		const sent = timeline.toasts.filter((t) => t.at >= LOOP_MS).map((t) => [t.at - LOOP_MS, t.title, t.body]);
		assert.deepEqual(sent, [
			[9_200, "✗ e2e #17 checkout failed", "pi · api"],
			[13_000, "✓ CI #42 green in 6m02s", "pi · webapp"],
			[13_200, "✓ Deploy #88 green in 2m40s", "pi · site"],
		]);
	});

	it("shows no toast for the tab on screen, like Herdr", () => {
		assert.deepEqual(
			sceneAt(timeline, 13_500).toasts.map((t) => t.title),
			["✓ Deploy #88 green in 2m40s"],
		);
	});

	it("marks Backend Tests as blocked only after the grace time, until the user answers", () => {
		assert.equal(state(10_500, "backend"), "idle");
		assert.equal(state(11_500, "backend"), "blocked");
		assert.equal(state(17_500, "backend"), "working");
		assert.equal(state(6_000, "webapp"), "working", "pi is on the failing test");
	});

	it("ends the loop with what Herdr shows when it starts, so the GIF has no seam", () => {
		const end = sceneAt(timeline, LOOP_MS - STEP_MS);
		const start = sceneAt(timeline, 0);
		assert.deepEqual(
			start.agents.map((a) => [a.state, a.tokens]),
			end.agents.map((a) => [a.state, a.tokens]),
		);
		assert.deepEqual([start.toasts, end.toasts], [[], []]);
	});

	it("moves a whole monitor by a loop, so the next loop reads the same", () => {
		for (const ms of [500, 6_000, 13_500, 20_000]) {
			const { now, items } = story(ms);
			assert.deepEqual(
				sidebarTokens(
					items.map((i) => shiftItem(i, LOOP_MS)),
					now + LOOP_MS,
				),
				sidebarTokens(items, now),
				`${ms} ms`,
			);
		}
	});

	it("runs virtual timers in time order, and only when the clock reaches them", async () => {
		const clock = new VirtualClock(T0);
		const ran: string[] = [];
		clock.setTimeout(() => ran.push("b"), 200);
		clock.setTimeout(() => ran.push("a"), 100);
		const cancelled = clock.setTimeout(() => ran.push("x"), 150);
		clock.clearTimeout(cancelled);
		await clock.advanceTo(T0 + 150);
		assert.deepEqual(ran, ["a"]);
		await clock.advanceTo(T0 + 300);
		assert.deepEqual(ran, ["a", "b"]);
		assert.equal(clock.now(), T0 + 300);
	});
});

describe("README Herdr recording frames", () => {
	const theme = piTheme("dark");
	const palette = paletteFor(theme);

	/** The character at a column, counting wide characters as two. */
	function charAt(line: string, column: number): string | undefined {
		let x = 0;
		for (const { segment } of new Intl.Segmenter().segment(stripTerminalSequences(line))) {
			if (x === column) return segment;
			x += visibleWidth(segment);
		}
		return undefined;
	}

	it("draws every row exactly as wide as the window, with the sidebar divider in place", () => {
		for (let ms = 0; ms < LOOP_MS; ms += 250) {
			const { lines, keys } = renderHerdr(sceneAt(timeline, ms), { theme, palette });
			assert.equal(lines.length, ROWS);
			assert.equal(keys.length, ROWS * COLS);
			lines.forEach((line, y) => {
				assert.equal(visibleWidth(line), COLS, `${ms} ms, row ${y}`);
				assert.equal(charAt(line, SIDEBAR), "│", `${ms} ms, row ${y}`);
			});
		}
	});

	it("colours the $mon row with the rule /monitors herdr writes for its first glyph", () => {
		const { lines } = renderHerdr(sceneAt(timeline, 6_500), { theme, palette });
		const row = lines.find((l) => stripTerminalSequences(l).includes("✗ CI #42 test failed"))!;
		const [r, g, b] = hex(palette.failed);
		assert.ok(row.includes(`38;2;${r};${g};${b}`), "red like the failure rule");
	});

	it("reads the dock's ANSI into cells with its colours and wide characters", () => {
		const cs = ansiCells("\x1b[38;2;1;2;3mok\x1b[0m ⏳\x1b]8;;https://x\x1b\\CI\x1b]8;;\x1b\\", [9, 9, 9]);
		assert.deepEqual(
			cs.map((c) => c.ch),
			["o", "k", " ", "⏳", "", "C", "I"],
		);
		assert.deepEqual(cs[0]!.fg, [1, 2, 3]);
		assert.deepEqual(cs[2]!.fg, [9, 9, 9]);
	});
});
