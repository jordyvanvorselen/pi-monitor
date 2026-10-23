import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Job } from "../src/sources/types.ts";
import { type Cell, cells, cellText, encode, fitCells, flatten, morph, truncCells } from "../src/ui/cells.ts";
import { clamp, contrast, hex, luminance, mix, pack, PALETTE, readable, type Rgb, smooth } from "../src/ui/color.ts";
import type { DockItem, DockOptions } from "../src/ui/dock.ts";
import {
	FADE_IN_MS,
	HOLD_MS,
	lookFor,
	MORPH_MS,
	renderRichDock,
	richRow,
	SETTLE_AT_MS,
	SETTLE_MS,
	type ThemeColors,
} from "../src/ui/dock-rich.ts";
import { ECG_STEP_MS, ecgCells, ecgText, etaCells, trackCells } from "../src/ui/effects.ts";
import { MIN_CONTRAST, ROLE_TOKENS } from "../src/ui/look.ts";
import { piTheme } from "../scripts/pi-theme.ts";
import { plainTheme } from "./helpers.ts";

const NOW = 1_700_000_400_000;

function richTheme(mode: "truecolor" | "256color" = "truecolor", appearance: "dark" | "light" = "dark") {
	return {
		...plainTheme,
		getColorMode: () => mode,
		appearance,
		colors: { text: rgbColor(230, 232, 235), muted: rgbColor(140, 144, 150), dim: rgbColor(90, 94, 100) },
	};
}

function tokenRgb(theme: Theme, token: string): Rgb {
	const c = (theme.colors as Record<string, ReturnType<typeof rgbColor>>)[token]!;
	return [c.r, c.g, c.b];
}

const look = lookFor(richTheme())!;
const look256 = lookFor(richTheme("256color"))!;
const still = { now: NOW, motion: false };

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
];

const ci = item({
	id: "ci",
	kind: "gh_run",
	status: "running",
	startedAt: NOW - 284_000,
	progress: { title: "CI #42", url: "https://github.com/acme/app/actions/runs/1", jobs, etaMs: 360_000 },
});
const beats = Array.from({ length: 30 }, (_, i) => ({ at: NOW - 30_000 + i * 1_000, amp: i % 4 ? 1 : 0.55 }));
const devServer = item({
	id: "dev",
	kind: "command",
	status: "running",
	description: "dev server",
	startedAt: NOW - 600_000,
	lastLine: "GET /api/users 200 in 12ms",
	lastLineAt: NOW - 1_000,
	beats,
});
const probation = item({
	id: "yarn",
	kind: "command",
	status: "running",
	description: "yarn dev",
	startedAt: NOW - 3_000,
	probationUntil: NOW + 8_200,
	lastLine: "ready in 420 ms",
	lastLineAt: NOW - 1_000,
	beats: [{ at: NOW - 1_000, amp: 1 }],
});
const failing = item({
	id: "e2e",
	kind: "gh_run",
	status: "running",
	startedAt: NOW - 131_000,
	handling: true,
	failingSince: NOW - 4_000,
	progress: {
		title: "e2e #17",
		etaMs: 300_000,
		jobs: [
			{ name: "setup", state: "success" },
			{ name: "checkout", state: "failure", step: "Run cart.spec.ts" },
			{ name: "pay", state: "queued" },
		],
	},
});
const green = (endedAgo: number) =>
	item({
		id: "ci41",
		kind: "gh_run",
		status: "success",
		startedAt: NOW - 400_000,
		endedAt: NOW - endedAgo,
		summary: "CI #41 green in 6m02s",
		progress: { title: "CI #41", jobs: jobs.map((j) => ({ ...j, state: "success" as const })), etaMs: 360_000 },
	});

function options(partial: Partial<DockOptions> = {}): DockOptions {
	return {
		width: 130,
		now: NOW,
		frame: 0,
		savedTokens: 6_200,
		shortcut: "ctrl+shift+m",
		reducedMotion: false,
		...partial,
	};
}

/** Escape codes made readable, so patterns can match them. */
const visible = (line: string) => line.replaceAll("\x1b", "ESC");
const plain = (lines: string[]) => lines.map((l) => stripTerminalSequences(l));
const text = (cs: readonly Cell[]) => cellText(cs).replace(/\s+$/, "");

describe("colour math", () => {
	it("blends from a to b and clamps the amount", () => {
		assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
		assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 2), [200, 100, 50]);
		assert.deepEqual(mix([0, 0, 0], [200, 100, 50], -1), [0, 0, 0]);
	});

	it("eases with smoothstep and clamps outside 0-1", () => {
		assert.equal(smooth(-1), 0);
		assert.equal(smooth(0.5), 0.5);
		assert.equal(smooth(3), 1);
		assert.equal(clamp(5, 0, 2), 2);
	});

	it("packs rounded channels so tiny float differences do not cause extra escape codes", () => {
		assert.equal(pack([60.2, 241.6, 200.4]), pack(hex("#3CF2C8")));
		assert.equal(pack([300, -5, 0]), 0xff0000);
	});
});

describe("cells", () => {
	it("gives a wide grapheme two cells so widths match the terminal", () => {
		const cs = cells("⏳ a", PALETTE.gold);
		assert.equal(cs.length, 4);
		assert.equal(cs[1]!.ch, "");
	});

	it("drops control characters that would break the grid", () => {
		assert.equal(cellText(cells("a\tb\u0007c", PALETTE.text)), "abc");
	});

	it("never cuts a wide grapheme in half when truncating", () => {
		const cut = truncCells(cells("ab⏳", PALETTE.text), 3, PALETTE.text);
		assert.equal(cellText(cut), "ab…");
		const between = truncCells(cells("a⏳bc", PALETTE.text), 3, PALETTE.text);
		assert.equal(visibleWidth(encode(between, "truecolor")), 3);
	});

	it("fits left and right into exactly the given width and drops the right side when it does not fit", () => {
		const left = cells("left side", PALETTE.text);
		const right = cells("right", PALETTE.text);
		assert.equal(cellText(fitCells(left, right, 20, PALETTE.text)), "left side      right");
		assert.equal(cellText(fitCells(left, right, 8, PALETTE.text)), "left si…");
	});

	it("dissolves line a into line b from right to left", () => {
		const a = cells("aaaa", PALETTE.text);
		const b = cells("bbbb", PALETTE.text);
		assert.equal(cellText(morph(a, b, 0)), "aaaa");
		assert.equal(cellText(morph(a, b, 1)), "bbbb");
		assert.equal(cellText(morph(a, b, 0.5)), "aabb");
	});

	it("fades text into the background with alpha", () => {
		const [faded] = flatten(cells("x", [200, 200, 200]), 0.5, [0, 0, 0]);
		assert.deepEqual(faded!.fg, [100, 100, 100]);
	});

	it("turns fully faded cells into plain spaces without background, so nothing lingers as a ghost", () => {
		const line = cells("ago ⏳", PALETTE.text, { bg: [60, 20, 30] });
		const gone = flatten(line, 0, [0, 0, 0]);
		assert.equal(cellText(gone), "      ");
		assert.ok(gone.every((c) => c.bg === undefined));
		assert.equal(encode(gone, "truecolor"), "      \x1b[0m");
	});

	it("drops cells a dissolve has fully faded out, and fades backgrounds with the text", () => {
		const a = cells("old", PALETTE.text, { bg: [60, 20, 30] });
		const b = cells("new", PALETTE.text);
		const middle = flatten(
			a.map((c) => ({ ...c, fade: 0 })),
			1,
			[0, 0, 0],
		);
		assert.equal(cellText(middle), "   ");
		assert.ok(middle.every((c) => c.bg === undefined));
		const half = flatten(a, 0.5, [0, 0, 0]);
		assert.deepEqual(half[0]!.bg, [30, 10, 15]);
		assert.equal(cellText(flatten(morph(a, b, 1), 1, [0, 0, 0])), "new");
	});

	it("encodes 24-bit colour, emits only changes and ends with a reset", () => {
		const line = [...cells("ab", [1, 2, 3]), ...cells("c", [1, 2, 3], { bold: true })];
		assert.equal(encode(line, "truecolor"), "\x1b[38;2;1;2;3mab\x1b[1mc\x1b[0m");
	});

	it("encodes 256 colours for terminals without truecolor", () => {
		const line = encode(cells("x", PALETTE.teal, { bg: [40, 40, 40] }), "256color");
		assert.match(visible(line), /ESC\[48;5;\d+mESC\[38;5;\d+mx/);
		assert.doesNotMatch(line, /;2;/);
	});

	it("wraps linked cells in one OSC 8 hyperlink", () => {
		const line = encode(cells("CI", PALETTE.text, { link: "https://x.test" }), "truecolor");
		assert.ok(line.includes("\x1b]8;;https://x.test\x1b\\"));
		assert.ok(line.includes("CI\x1b]8;;\x1b\\"));
	});
});

describe("heartbeat", () => {
	const step = (n: number) => n * ECG_STEP_MS;

	it("draws a solid baseline without lines", () => {
		assert.equal(ecgText([], step(1007), 3), "▁▁▁");
	});

	it("draws a full-height spike and a low bump for a line", () => {
		assert.equal(ecgText([{ at: step(1000), amp: 1 }], step(1007), 9), "▁╱╲▁▂▂▁▁▁");
	});

	it("scrolls left one cell every 250 ms", () => {
		assert.equal(ecgText([{ at: step(1000), amp: 1 }], step(1008), 9), "╱╲▁▂▂▁▁▁▁");
	});

	it("draws a smaller blip without the tall spike for lines in a burst", () => {
		assert.equal(ecgText([{ at: step(1000), amp: 0.55 }], step(1004), 5), "▂▃▂▁▁");
	});

	it("keeps the taller part where beats overlap", () => {
		const beats = [
			{ at: step(1000), amp: 0.55 },
			{ at: step(1001), amp: 1 },
		];
		assert.equal(ecgText(beats, step(1003), 4), "▂╱╲▁");
	});

	it("stays blank before the monitor started", () => {
		assert.equal(ecgText([], step(1007), 5, step(1004)), " ▁▁▁▁");
	});

	it("is bright at the head and keeps the tail visible", () => {
		const trace = ecgCells([], step(1007), 6, look, still);
		const brightness = (c: Cell) => c.fg[0] + c.fg[1] + c.fg[2];
		assert.ok(brightness(trace[5]!) > brightness(trace[2]!));
		assert.ok(brightness(trace[2]!) > brightness(trace[0]!));
		assert.ok(contrast(trace[0]!.fg, look.background) >= 1.8, "tail still visible");
		assert.equal(trace[5]!.bold, true);
	});

	it("lights the head cell background only right after a line arrives", () => {
		const hot = ecgCells([{ at: NOW - 100, amp: 1 }], NOW, 4, look, { now: NOW, motion: true });
		assert.ok(hot[3]!.bg);
		const cool = ecgCells([{ at: NOW - 2_000, amp: 1 }], NOW, 4, look, { now: NOW, motion: true });
		assert.equal(cool[3]!.bg, undefined);
	});
});

describe("ETA bar", () => {
	it("fills with eighth blocks for a smooth edge", () => {
		assert.equal(cellText(etaCells(180_000, 360_000, 5, look, still)), "██▌   ~3m");
	});

	it("shows overtime and done", () => {
		assert.equal(cellText(etaCells(420_000, 360_000, 5, look, still)), "█████ +1m");
		assert.equal(cellText(etaCells(360_000, 360_000, 5, look, still, { done: true })), "█████ done");
	});

	it("runs from the warning to the success colour over a recessed track", () => {
		const bar = etaCells(360_000, 360_000, 5, look, still);
		assert.deepEqual(bar[0]!.fg, look.warning);
		assert.deepEqual(bar[4]!.fg, look.success);
		assert.ok(bar.slice(0, 5).every((c) => c.bg));
	});

	it("uses dots instead of a background track in 256 colours", () => {
		assert.equal(cellText(etaCells(180_000, 360_000, 5, look256, still)), "██▌·· ~3m");
	});
});

describe("job track", () => {
	it("keeps the glyphs of the plain track", () => {
		assert.equal(cellText(trackCells(jobs, 30, look, still)), "●━━●━━◐┄┄○");
	});

	it("turns the running node over time", () => {
		const at = (ms: number) => cellText(trackCells(jobs, 30, look, { now: ms, motion: true }))[6];
		assert.deepEqual([0, 170, 340, 510].map(at), ["◐", "◓", "◑", "◒"]);
	});

	it("keeps the running node still without motion", () => {
		assert.equal(cellText(trackCells(jobs, 30, look, { now: 170, motion: false }))[6], "◐");
	});

	it("falls back to a count when the track does not fit", () => {
		assert.equal(cellText(trackCells(jobs, 5, look, still)), "2/4");
	});
});

describe("choosing the look", () => {
	it("uses the colour dock with Pi's theme on a dark background", () => {
		assert.equal(lookFor(richTheme())?.mode, "truecolor");
		assert.equal(lookFor(richTheme())?.tints, true);
	});

	it("uses 256 colours without background tints when the terminal lacks truecolor", () => {
		assert.equal(look256.mode, "256color");
		assert.equal(look256.tints, false);
	});

	it("falls back to the plain dock when the theme has no colour mode", () => {
		assert.equal(lookFor(plainTheme as ThemeColors), undefined);
	});

	it("treats the background as light when the terminal reports a light one, whatever the theme says", () => {
		assert.equal(lookFor(richTheme(), { background: [250, 250, 250] })?.light, true);
		assert.equal(lookFor(richTheme("truecolor", "light"), { background: [20, 20, 30] })?.light, false);
		assert.equal(lookFor(richTheme("truecolor", "light"))?.light, true);
	});

	it("takes text tones from the theme and blends into the reported terminal background", () => {
		const own = lookFor(richTheme(), { background: [30, 30, 46] })!;
		assert.deepEqual(own.text, [230, 232, 235]);
		assert.deepEqual(own.background, [30, 30, 46]);
	});
});

describe("colour dock", () => {
	const all = [ci, devServer, probation, failing];

	it("keeps the content of the plain dock", () => {
		const lines = plain(renderRichDock(all, options(), look, plainTheme));
		assert.equal(lines.length, 6);
		assert.match(lines[0]!, /^╭─ ◉ monitors ─+ 4 running · 1 failed · saved ~6\.2k tok ─╮$/);
		assert.match(
			lines[1]!,
			/^│ ⠋ e2e #17 +●━━✗┄┄○ {2}checkout ✗ Run cart\.spec\.ts +pi is on it ↳ {2}\S+ +~2m {3}2m11s │$/,
		);
		assert.match(lines[2]!, /^│ ⠋ dev server {2}[▁▂▃╱╲]{18} {2}last: GET \/api\/users 200 in 12ms · 1s ago +10m00s │$/);
		assert.match(lines[3]!, /^│ ⠋ CI #42 {6}●━━●━━◐┄┄○ {2}test ▸ Run unit tests +\S+ +~1m {3}4m44s │$/);
		assert.match(lines[4]!, /^│ ⏳ yarn dev +[▁▂▃╱╲ ]{18} {2}last: ready in 420 ms · 1s ago +background in {2}9s │$/);
		assert.match(lines[5]!, /^╰─+ ctrl\+shift\+m details ─╯$/);
	});

	it("lines up names so tracks and heartbeats start in the same column", () => {
		const lines = plain(renderRichDock([ci, devServer], options(), look, plainTheme));
		const trackAt = lines[2]!.indexOf("●");
		const traceAt = lines[1]!.search(/[▁▂▃╱╲]{4}/);
		assert.equal(trackAt, traceAt);
	});

	it("keeps every line exactly as wide as the terminal at every width, time and colour mode", () => {
		const more = [1, 2].map((n) => item({ id: `run${n}`, kind: "command", status: "running" }));
		const sets = [all, [...all, ...more], [green(200), devServer], [green(650), probation], [green(5_000)]];
		for (const [name, l] of [
			["truecolor", look],
			["256", look256],
			["light truecolor", lookFor(piTheme("light"))!],
			["light 256", lookFor(piTheme("light", "256color"))!],
		] as const)
			for (const reducedMotion of [false, true])
				for (const items of sets)
					for (const width of [200, 130, 112, 104, 92, 88, 80, 60, 56, 50, 40, 30, 24])
						for (const at of [0, 333, 1_250, 2_900])
							for (const line of renderRichDock(items, options({ width, now: NOW + at, reducedMotion }), l, plainTheme))
								assert.equal(visibleWidth(line), width, `${name} width ${width} +${at}ms: ${line}`);
	});

	it("uses compact rows at narrow width", () => {
		const lines = plain(renderRichDock([ci, probation], options({ width: 50 }), look, plainTheme));
		assert.match(lines[1]!, /^│ ⠋ CI #42 2\/4 4m +│$/);
		assert.match(lines[2]!, /^│ ⏳ yarn dev bg in 9s +│$/);
	});

	it("folds more than four rows into +N more", () => {
		const more = [1, 2].map((n) => item({ id: `run${n}`, kind: "command", status: "running" }));
		const lines = plain(renderRichDock([...all, ...more], options(), look, plainTheme));
		assert.equal(lines.length, 6);
		assert.match(lines[4]!, /\+3 more · \/monitors/);
	});

	it("uses one line when the terminal is too narrow for a card", () => {
		assert.equal(renderRichDock(all, options({ width: 23 }), look, plainTheme).length, 1);
	});

	it("hides entirely when nothing is visible", () => {
		assert.deepEqual(renderRichDock([green(11_000)], options(), look, plainTheme), []);
	});

	it("links the run name to GitHub", () => {
		const lines = renderRichDock([ci], options(), look, plainTheme);
		assert.ok(lines[1]!.includes("\x1b]8;;https://github.com/acme/app/actions/runs/1\x1b\\"));
	});

	it("sweeps a highlight along the top border and shimmers the title over time", () => {
		const top = (at: number) => renderRichDock([ci], options({ now: at }), look, plainTheme)[0];
		const start = Math.ceil(NOW / 6_000) * 6_000;
		assert.notEqual(top(start + 600), top(start + 900));
	});
});

describe("colour dock moments", () => {
	const hasBackground = (line: string) => line.includes("\x1b[48;2;");

	it("breathes a red glow behind a failing run", () => {
		// Medium width has no ETA track, so any background colour is the glow.
		const lines = renderRichDock([failing], options({ width: 80 }), look, plainTheme);
		assert.ok(hasBackground(lines[1]!));
		const amount = (at: number) => richRow(failing, 76, look, at).glow!.amount;
		assert.notEqual(amount(NOW), amount(NOW + 800));
	});

	it("flashes a teal glow when a run goes green and lets it fade", () => {
		assert.ok(hasBackground(renderRichDock([green(200)], options({ width: 80 }), look, plainTheme)[1]!));
		assert.ok(!hasBackground(renderRichDock([green(5_000)], options({ width: 80 }), look, plainTheme)[1]!));
	});

	it("shows the green run first, then dissolves it into the one-line summary", () => {
		const row = (ago: number) => text(richRow(green(ago), 126, look, NOW).cells);
		assert.match(row(100), /^✓ CI #41 +●━━●━━●━━● {2}all 4 jobs passed .*done {3}6m40s$/);
		assert.equal(row(HOLD_MS + MORPH_MS + 10), "✓ CI #41 green in 6m02s");
		const mid = row(HOLD_MS + MORPH_MS / 2);
		assert.notEqual(mid, row(100));
		assert.notEqual(mid, row(HOLD_MS + MORPH_MS + 10));
	});

	it("shows the summary bold in the result colour, then settles to muted", () => {
		const summaryCell = (ago: number) => richRow(green(ago), 126, look, NOW).cells[2]!;
		const flash = summaryCell(HOLD_MS + MORPH_MS + 10);
		assert.deepEqual(flash.fg, look.success);
		assert.equal(flash.bold, true);
		const settled = summaryCell(SETTLE_AT_MS + SETTLE_MS + 10);
		assert.deepEqual(settled.fg, look.muted);
		assert.equal(settled.bold, false);
	});

	it("draws a row that is still invisible as plain spaces without background", () => {
		const lines = renderRichDock([{ ...failing, startedAt: NOW }], options({ width: 80 }), look, plainTheme);
		const row = lines[1]!;
		assert.match(stripTerminalSequences(row), /^│ {78}│$/);
		assert.ok(!row.includes("\x1b[48;"));
	});

	it("fades new rows in and finished rows out", () => {
		assert.ok(richRow({ ...ci, startedAt: NOW - FADE_IN_MS / 4 }, 126, look, NOW).alpha < 0.5);
		assert.equal(richRow(ci, 126, look, NOW).alpha, 1);
		assert.ok(richRow(green(9_900), 126, look, NOW).alpha < 0.2);
	});

	it("counts down the probation row in the warning colour", () => {
		const row = richRow(probation, 126, look, NOW).cells;
		assert.match(text(row), /background in {2}9s$/);
		assert.deepEqual(row.at(-1)!.fg, look.warning);
	});

	it("brightens the last line for a moment when it arrives", () => {
		const fresh = { ...devServer, lastLineAt: NOW - 50 };
		const at = (it: DockItem) => richRow(it, 126, look, NOW).cells.find((c) => c.ch === "G")!.fg;
		assert.ok(at(fresh)[0] > at(devServer)[0]);
	});
});

describe("colour dock with reducedMotion", () => {
	const calm = (partial: Partial<DockOptions> = {}) => options({ reducedMotion: true, ...partial });

	it("shows no spinner, no glow and no flash", () => {
		const lines = renderRichDock([failing, green(200)], calm({ width: 80 }), look, plainTheme);
		const out = plain(lines).join("\n");
		assert.doesNotMatch(out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		assert.match(out, /◉ e2e #17/);
		assert.ok(!lines.some((l) => l.includes("\x1b[48;2;")));
		assert.match(out, /✓ CI #41 green in 6m02s/);
	});

	it("keeps border, title and shimmer colours still over time", () => {
		const frame = (at: number) => renderRichDock([ci, devServer, failing], calm({ now: at }), look, plainTheme);
		const [a, b] = [frame(NOW + 600), frame(NOW + 4_100)];
		assert.equal(a[0], b[0]);
		assert.equal(a.at(-1), b.at(-1));
		const handling = (at: number) => {
			const row = richRow(failing, 126, look, at, true).cells;
			const start = cellText(row).indexOf("pi is on it");
			return row.slice(start, start + 11).map((c) => pack(c.fg));
		};
		assert.deepEqual(handling(NOW + 600), handling(NOW + 4_100));
	});

	it("still ticks the clocks once a second", () => {
		const row = (at: number) => plain(renderRichDock([ci], calm({ now: at }), look, plainTheme))[1];
		assert.notEqual(row(NOW), row(NOW + 1_000));
	});
});

describe("colour dock without truecolor", () => {
	it("draws in 256 colours and never paints a background glow", () => {
		const lines = renderRichDock([failing, green(200)], options({ width: 80 }), look256, plainTheme);
		const out = lines.join("\n");
		assert.match(visible(out), /ESC\[38;5;\d+m/);
		assert.doesNotMatch(out, /;2;\d+;\d+;\d+m/);
		assert.ok(!out.includes("\x1b[48;"));
	});
});

describe("colour dock on light themes", () => {
	const light = piTheme("light");
	const lightLook = lookFor(light)!;
	const hotNow = 1_600 * 1_100_000_000;
	const hotBeats = [5, 4, 3, 2, 1, 0].map((i) => ({ at: hotNow - 100 - i * 900, amp: 1 }));

	it("draws the colour dock on Pi's light theme in truecolor and 256 colours", () => {
		assert.equal(lightLook.light, true);
		assert.equal(lookFor(piTheme("light", "256color"))?.mode, "256color");
	});

	for (const name of ["light", "dark"] as const)
		it(`takes every colour role from Pi's ${name} theme tokens`, () => {
			const theme = piTheme(name);
			const own = lookFor(theme)!;
			for (const role of ["success", "link", "error", "warning", "border", "text", "muted", "dim", "output"] as const)
				assert.deepEqual(own[role], tokenRgb(theme, ROLE_TOKENS[role][0]), role);
		});

	it("falls back to deep built-in colours for roles a light theme does not have", () => {
		const bare = lookFor({ getColorMode: () => "truecolor", appearance: "light", colors: {} })!;
		for (const role of ["success", "link", "error", "warning"] as const)
			assert.ok(contrast(bare[role], bare.background) >= MIN_CONTRAST, role);
	});

	it("darkens theme accents that would be too pale to read on the background", () => {
		const pale = lookFor({
			getColorMode: () => "truecolor",
			appearance: "light",
			colors: { success: rgbColor(190, 255, 225) },
		})!;
		assert.ok(contrast(pale.success, pale.background) >= MIN_CONTRAST);
		assert.ok(luminance(pale.success) < luminance([190, 255, 225]));
		assert.deepEqual(readable([0, 0, 0], [255, 255, 255], [0, 0, 0]), [0, 0, 0]);
	});

	it("uses palette colours the terminal reported for theme colours given as ANSI indexes", () => {
		const ansi = lookFor(
			{ getColorMode: () => "truecolor", appearance: "light", colors: { error: { kind: "indexed", index: 1 } } },
			{ palette: [undefined, [170, 20, 30]] },
		)!;
		assert.deepEqual(ansi.error, [170, 20, 30]);
	});

	it("darkens the hot head, tips and glints instead of turning them white", () => {
		const head = ecgCells(hotBeats, hotNow, 18, lightLook, { now: hotNow, motion: true }).at(-1)!;
		assert.ok(luminance(head.fg) < 0.2, "heartbeat head");
		assert.ok(contrast(lightLook.highlight, lightLook.background) >= 7, "highlight");
		const node = trackCells(jobs, 30, lightLook, { now: hotNow, motion: true })[6]!;
		assert.ok(contrast(node.fg, lightLook.background) >= MIN_CONTRAST, "running node");
		const fresh = richRow({ ...devServer, lastLineAt: hotNow - 50 }, 126, lightLook, hotNow).cells.find(
			(c) => c.ch === "G",
		)!;
		assert.ok(
			contrast(fresh.fg, lightLook.background) >= contrast(lightLook.output, lightLook.background),
			"fresh line",
		);
	});

	it("keeps text readable on the strongest glow", () => {
		const peak = { ...failing, failingSince: hotNow - 1_600 * 3 };
		const lines = renderRichDock([peak], options({ width: 80, now: hotNow }), lightLook, plainTheme);
		const tints = lines.flatMap((l) =>
			[...l.matchAll(/48;2;(\d+);(\d+);(\d+)m/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!] as Rgb),
		);
		assert.ok(tints.length > 0);
		for (const bg of tints) {
			assert.ok(contrast(lightLook.text, bg) >= 4.5, `text on ${bg}`);
			assert.ok(contrast(lightLook.error, bg) >= MIN_CONTRAST, `error on ${bg}`);
		}
	});

	it("glows softer on light backgrounds than on dark ones", () => {
		const dark = lookFor(piTheme("dark"))!;
		const at = (l: typeof dark) => richRow(failing, 76, l, NOW).glow!.amount;
		assert.ok(at(lightLook) < at(dark));
	});

	it("keeps the border visible against a light background", () => {
		const lines = renderRichDock([ci], options({ reducedMotion: true }), lightLook, plainTheme);
		const corner = /38;2;(\d+);(\d+);(\d+)m╭/.exec(lines[0]!)!;
		assert.ok(contrast([+corner[1]!, +corner[2]!, +corner[3]!], lightLook.background) >= 1.8);
	});
});
