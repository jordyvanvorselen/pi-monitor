// Dock v2: the dock drawn cell by cell in 24-bit (or 256) colour, with the animations from the launch video.
// `renderDock` in dock.ts stays the fallback for light themes and themes without a colour mode.
import { type Color, colorToRgb } from "@earendil-works/pi-tui";
import { formatDuration, formatShortDuration, formatTokens } from "../format.ts";
import type { MonitorStatus } from "../registry.ts";
import {
	type Cell,
	type ColorMode,
	cells,
	encode,
	fitCells,
	flatten,
	morph,
	padCells,
	spaces,
	truncCells,
} from "./cells.ts";
import { clamp, lightness, mix, PALETTE, type Rgb, smooth } from "./color.ts";
import {
	borderColor,
	type Clock,
	ecgCells,
	etaCells,
	type Glow,
	handlingCells,
	jobCountText,
	lastBeat,
	type Look,
	spinnerGlyph,
	titleCells,
	trackCells,
} from "./effects.ts";
import {
	byImportance,
	displayName,
	type DockItem,
	type DockOptions,
	finishedText,
	hasFailure,
	isVisible,
	LINGER_MS,
	MAX_ROWS,
	MEDIUM,
	renderLine,
	STALE_MS,
	WAITING,
	WIDE,
} from "./dock.ts";
import type { Paint } from "./glyphs.ts";

const { teal, red, gold, white } = PALETTE;

/** A finished row keeps its last running layout this long, then dissolves into its one-line summary. */
export const HOLD_MS = 300;
export const MORPH_MS = 700;
/** The summary shows bold in the result colour, then settles to muted. */
export const SETTLE_AT_MS = 1_500;
export const SETTLE_MS = 700;
/** New rows fade in, finished rows fade out before they disappear. */
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 800;

/** Names are padded to this width so tracks and heartbeats line up. */
const NAME_COL = 12;

/** The parts of Pi's `Theme` that tell how to draw in colour. */
export interface ThemeColors {
	getColorMode?(): ColorMode;
	readonly appearance?: "dark" | "light";
	readonly colors?: Readonly<Record<string, Color>>;
}

function rgbOf(color: Color | undefined): Rgb | undefined {
	if (!color) return undefined;
	const { r, g, b } = colorToRgb(color);
	return [r, g, b];
}

/**
 * The look for a theme, or undefined when the dock should use the plain theme rendering:
 * no colour mode (not Pi's theme) or a light background, where the palette would be unreadable.
 */
export function lookFor(theme: ThemeColors, background?: Rgb): Look | undefined {
	let mode: ColorMode | undefined;
	let colors: Readonly<Record<string, Color>> | undefined;
	try {
		mode = theme.getColorMode?.();
		colors = theme.colors;
	} catch {
		return undefined;
	}
	if (mode !== "truecolor" && mode !== "256color") return undefined;
	if (background ? lightness(background) > 0.5 : theme.appearance === "light") return undefined;
	const bg = background ?? PALETTE.background;
	const text = rgbOf(colors?.text) ?? PALETTE.text;
	return {
		mode,
		background: bg,
		text,
		muted: rgbOf(colors?.muted) ?? mix(bg, text, 0.56),
		dim: rgbOf(colors?.dim) ?? mix(bg, text, 0.3),
		faint: mix(bg, text, 0.16),
		output: rgbOf(colors?.toolOutput) ?? mix(bg, text, 0.8),
		warning: rgbOf(colors?.warning) ?? gold,
		tints: mode === "truecolor",
	};
}

interface Ctx {
	look: Look;
	clock: Clock;
	now: number;
}

type EndStatus = Exclude<MonitorStatus, "running">;

function endStyle(status: EndStatus, look: Look): [string, Rgb] {
	if (status === "success") return ["✓", teal];
	if (status === "failure") return ["✗", red];
	if (status === "timeout") return ["◔", look.warning];
	if (status === "stopped") return ["■", look.dim];
	return ["◌", look.dim];
}

const isGh = (item: DockItem) => item.kind === "gh_run" || item.kind === "gh_pr";

function glyphCells(item: DockItem, ctx: Ctx, end?: EndStatus): Cell[] {
	if (end) {
		const [glyph, color] = endStyle(end, ctx.look);
		return cells(glyph, color, { bold: true });
	}
	if (item.probationUntil !== undefined) return cells("⏳", gold);
	if (item.paused) return cells("‖", ctx.look.warning);
	return cells(spinnerGlyph(ctx.clock), hasFailure(item) ? red : teal, { bold: true });
}

function nameCells(item: DockItem, look: Look): Cell[] {
	const url = item.progress.url;
	return cells(displayName(item), look.text, { bold: true, ...(url ? { link: url } : {}) });
}

/** Glyph and name, padded so the next column lines up across rows. */
function headCells(item: DockItem, ctx: Ctx, end?: EndStatus): Cell[] {
	const glyph = glyphCells(item, ctx, end);
	const name = nameCells(item, ctx.look);
	const nameWidth = Math.max(name.length + 2, NAME_COL - (glyph.length - 1));
	return [...glyph, ...spaces(1, ctx.look.text), ...padCells(name, nameWidth, ctx.look.text)];
}

function countdown(item: DockItem, now: number): string | undefined {
	if (item.probationUntil === undefined) return undefined;
	return formatShortDuration(Math.max(0, Math.ceil((item.probationUntil - now) / 1000) * 1000));
}

function ageCells(ms: number, look: Look): Cell[] {
	if (ms >= STALE_MS) return cells(`quiet ${formatShortDuration(ms)}`, look.warning);
	return cells(`${formatShortDuration(ms)} ago`, ms < 60_000 ? look.muted : look.dim);
}

function joinCells(parts: readonly Cell[][], gap: number, fg: Rgb): Cell[] {
	return parts.flatMap((part, i) => (i ? [...spaces(gap, fg), ...part] : part));
}

/** Right side of a running row: `pi is on it ↳`, ETA bar, then the clock or the probation countdown. */
function rightCells(item: DockItem, iw: number, ctx: Ctx, at: number, end?: EndStatus): Cell[] {
	const { look, clock } = ctx;
	const elapsed = at - (item.progress.startedAt ?? item.startedAt);
	const parts: Cell[][] = [];
	if (item.handling) parts.push(handlingCells(clock));
	if (iw >= WIDE && isGh(item) && item.progress.etaMs)
		parts.push(
			etaCells(elapsed, item.progress.etaMs, iw >= 104 ? 10 : 6, look, clock, {
				failing: hasFailure(item),
				done: end === "success",
			}),
		);
	const left = end ? undefined : countdown(item, at);
	if (left) parts.push([...cells("background in ", look.dim), ...cells(left.padStart(3), gold)]);
	else parts.push(cells(formatDuration(elapsed).padStart(6), look.muted));
	return joinCells(parts, 2, look.text);
}

function ghDetailCells(item: DockItem, ctx: Ctx, end?: EndStatus): Cell[] {
	const { look } = ctx;
	const jobs = item.progress.jobs ?? [];
	if (end === "success") return cells(jobs.length ? `all ${jobs.length} jobs passed` : "passed", teal);
	if (item.paused) return cells("paused (too noisy)", look.warning);
	const running = jobs.filter((j) => j.state === "running");
	const failed = jobs.find((j) => j.state === "failure");
	const more = (n: number) => (n > 0 ? cells(` +${n}`, look.dim) : []);
	if (failed)
		return [
			...cells(failed.name, look.text),
			...cells(" ✗ ", red, { bold: true }),
			...cells(failed.step ?? "failed", mix(red, look.text, 0.45)),
			...more(running.length),
		];
	const current = running[0];
	if (current) {
		const step = current.step ? [...cells(" ▸ ", look.dim), ...cells(current.step, look.muted)] : [];
		return [...cells(current.name, look.text), ...step, ...more(running.length - 1)];
	}
	if (jobs.some((j) => j.state === "queued")) return cells("waiting for a runner", look.dim);
	return cells(WAITING[item.kind], look.dim);
}

function ghRow(item: DockItem, iw: number, ctx: Ctx, at: number, end?: EndStatus): Cell[] {
	const { look, clock } = ctx;
	const jobs = item.progress.jobs ?? [];
	const left = headCells(item, ctx, end);
	if (jobs.length) left.push(...trackCells(jobs, iw >= WIDE ? 30 : 16, look, clock), ...spaces(2, look.text));
	left.push(...ghDetailCells(item, ctx, end));
	return fitCells(left, rightCells(item, iw, ctx, at, end), iw, look.text);
}

function commandRow(item: DockItem, iw: number, ctx: Ctx, at: number, end?: EndStatus): Cell[] {
	const { look, clock, now } = ctx;
	const head = headCells(item, ctx, end);
	// Without motion the trace moves with the clocks, once a second.
	const traceAt = clock.motion ? now : Math.floor(now / 1000) * 1000;
	if (iw >= WIDE)
		head.push(
			...ecgCells(item.beats ?? [], traceAt, iw >= 112 ? 18 : 12, look, clock, item.startedAt),
			...spaces(2, look.text),
		);
	const right = rightCells(item, iw, ctx, at, end);
	if (item.paused) return fitCells([...head, ...cells("paused (too noisy)", look.warning)], right, iw, look.text);
	if (item.lastLine === undefined || item.lastLineAt === undefined)
		return fitCells([...head, ...cells(WAITING[item.kind], look.dim)], right, iw, look.text);
	const prefix = [...head, ...cells("last: ", look.dim)];
	const ago = now - item.lastLineAt;
	const suffix = [...cells(" · ", look.dim), ...ageCells(ago, look)];
	const room = iw - prefix.length - suffix.length - right.length - 2;
	const fresh = clock.motion ? clamp(1 - ago / 800) : 0;
	const line = cells(item.lastLine.replace(/\s+/g, " ").trim(), mix(look.output, white, fresh * 0.6));
	return fitCells([...prefix, ...truncCells(line, Math.max(6, room), look.dim), ...suffix], right, iw, look.text);
}

/** Narrow rows: `⠹ CI #42 3/5 4m`. */
function compactRow(item: DockItem, iw: number, ctx: Ctx, at: number, end?: EndStatus): Cell[] {
	const { look } = ctx;
	const parts: Cell[][] = [glyphCells(item, ctx, end), nameCells(item, look)];
	const jobs = item.progress.jobs;
	if (isGh(item) && jobs?.length) {
		const { text, failed } = jobCountText(jobs);
		parts.push(cells(text, failed ? red : look.muted));
	}
	const left = end ? undefined : countdown(item, at);
	const elapsed = at - (item.progress.startedAt ?? item.startedAt);
	parts.push(left ? cells(`bg in ${left}`, look.dim) : cells(formatShortDuration(elapsed), look.muted));
	if (!isGh(item) && item.lastLineAt !== undefined && at - item.lastLineAt >= STALE_MS)
		parts.push(ageCells(at - item.lastLineAt, look));
	if (item.handling) parts.push(cells("↳", teal));
	return fitCells(joinCells(parts, 1, look.text), [], iw, look.text);
}

function activeRow(item: DockItem, iw: number, ctx: Ctx, at: number, end?: EndStatus): Cell[] {
	if (iw < MEDIUM) return compactRow(item, iw, ctx, at, end);
	return isGh(item) ? ghRow(item, iw, ctx, at, end) : commandRow(item, iw, ctx, at, end);
}

/** `✓ CI #42 green in 6m02s`: bold in the result colour while `settle` is low, muted once it reaches 1. */
function doneRow(item: DockItem, iw: number, ctx: Ctx, settle: number): Cell[] {
	const { look, clock } = ctx;
	const status = item.status as EndStatus;
	const [glyph, color] = endStyle(status, look);
	const quiet = status === "stopped" || status === "ended";
	const textColor = quiet ? look.muted : mix(color, look.muted, settle);
	const left = [
		...cells(glyph, color, { bold: true }),
		...spaces(1, look.text),
		...cells(finishedText(item), textColor, { bold: !quiet && settle < 0.5 }),
	];
	return fitCells(left, item.handling ? handlingCells(clock) : [], iw, look.text);
}

/** Red breathing: a quick flash when the failure appears, then a slow pulse. */
function breathing(since: number | undefined, now: number): number {
	if (since === undefined) return 0.72 + 0.28 * Math.cos((now * Math.PI * 2) / 1600);
	const t = now - since;
	return smooth(t / 120) * (0.72 + 0.28 * Math.cos((t * Math.PI * 2) / 1600) + 0.5 * clamp(1 - t / 700));
}

/** The glow behind a row right now, if any. */
export function rowGlow(item: DockItem, now: number, look: Look): Glow | undefined {
	if (item.status === "running")
		return hasFailure(item) ? { color: red, amount: breathing(item.failingSince, now) } : undefined;
	if (item.endedAt === undefined) return undefined;
	const e = now - item.endedAt;
	if (item.status === "success")
		return { color: teal, amount: smooth(e / 120) * Math.exp(-Math.max(0, e - 120) / 750) * 1.1 };
	if (item.status === "failure") return { color: red, amount: breathing(item.endedAt, now) };
	if (item.status === "timeout") return { color: look.warning, amount: breathing(item.endedAt, now) * 0.7 };
	return undefined;
}

export interface RowFrame {
	cells: Cell[];
	alpha: number;
	glow?: Glow | undefined;
}

/** One row at `now`: its cells (inner width), how visible it is and the glow behind it. */
export function richRow(item: DockItem, innerWidth: number, look: Look, now: number, reducedMotion = false): RowFrame {
	return rowFrame(item, innerWidth, { look, clock: { now, motion: !reducedMotion }, now });
}

function rowFrame(item: DockItem, iw: number, ctx: Ctx): RowFrame {
	const { now, clock, look } = ctx;
	const motion = clock.motion;
	let alpha = motion ? smooth((now - item.startedAt) / FADE_IN_MS) : 1;
	const glow = motion ? rowGlow(item, now, look) : undefined;
	if (item.status === "running") return { cells: activeRow(item, iw, ctx, now), alpha, glow };

	const e = now - (item.endedAt ?? now);
	if (motion) alpha *= 1 - smooth((e - (LINGER_MS - FADE_OUT_MS)) / FADE_OUT_MS);
	const done = doneRow(item, iw, ctx, motion ? smooth((e - SETTLE_AT_MS) / SETTLE_MS) : 1);
	if (!motion || item.status === "ended" || e >= HOLD_MS + MORPH_MS) return { cells: done, alpha, glow };
	const last = activeRow(item, iw, ctx, item.endedAt ?? now, item.status);
	return { cells: e < HOLD_MS ? last : morph(last, done, (e - HOLD_MS) / MORPH_MS), alpha, glow };
}

function summaryCells(items: readonly DockItem[], saved: number, look: Look): Cell[] {
	const running = items.filter((i) => i.status === "running").length;
	const failed = items.filter(hasFailure).length;
	const parts: Cell[][] = [];
	if (running) parts.push(cells(`${running} running`, look.muted));
	if (failed) parts.push(cells(`${failed} failed`, red, { bold: true }));
	if (saved >= 100)
		parts.push([
			...cells("saved ~", look.muted),
			...cells(formatTokens(saved), look.text),
			...cells(" tok", look.muted),
		]);
	return parts.flatMap((part, i) => (i ? [...cells(" · ", look.dim), ...part] : part));
}

/** The header dot lights up when a line arrives anywhere. */
function pulse(items: readonly DockItem[], ctx: Ctx): number {
	if (!ctx.clock.motion) return 0;
	let best = 0;
	for (const item of items) {
		const beat = item.status === "running" ? lastBeat(item.beats, ctx.now) : undefined;
		if (beat) best = Math.max(best, clamp(1 - (ctx.now - beat.at) / 700));
	}
	return best;
}

function topBorder(items: readonly DockItem[], width: number, saved: number, ctx: Ctx, tint?: Glow): Cell[] {
	const { look, clock } = ctx;
	const running = items.some((i) => i.status === "running");
	const glow = pulse(items, ctx);
	const dot = running ? mix(mix(look.background, teal, 0.5), mix(teal, white, 0.4), glow) : look.muted;
	const sp = spaces(1, look.text);
	const left: Cell[] = [{ ch: "╭", fg: look.text }, { ch: "─", fg: look.text }, ...sp];
	left.push(...cells("◉", dot, { bold: true }), ...sp, ...titleCells(clock), ...sp);
	const summary = summaryCells(items, saved, look);
	let right = summary.length ? [...sp, ...summary, ...sp] : [];
	if (left.length + right.length + 2 > width) right = [];
	const line = [...left];
	while (line.length < width - right.length - 2) line.push({ ch: "─", fg: look.text });
	line.push(...right, { ch: "─", fg: look.text }, { ch: "╮", fg: look.text });
	return paintBorder(truncCells(line, width, look.dim), 1, ctx, tint);
}

function bottomBorder(width: number, shortcut: string, ctx: Ctx, tint?: Glow): Cell[] {
	const { look } = ctx;
	let foot = [...spaces(1, look.text), ...cells(shortcut, look.muted), ...cells(" details", look.dim)];
	foot.push(...spaces(1, look.text));
	if (foot.length + 4 > width) foot = [];
	const line: Cell[] = [{ ch: "╰", fg: look.text }];
	while (line.length < width - foot.length - 2) line.push({ ch: "─", fg: look.text });
	line.push(...foot, { ch: "─", fg: look.text }, { ch: "╯", fg: look.text });
	return paintBorder(line, -1, ctx, tint);
}

const BORDER = new Set(["╭", "╮", "╰", "╯", "─", "│"]);

/** Colour the box-drawing cells of a border line. Title and summary keep their own colours. */
function paintBorder(line: Cell[], row: -1 | 1, ctx: Ctx, tint?: Glow): Cell[] {
	return line.map((c, i) =>
		BORDER.has(c.ch) ? { ...c, fg: borderColor(i, line.length, row, ctx.look, ctx.clock, tint) } : c,
	);
}

/** Tint the background around a glowing row: strongest on the row, bleeding two lines up and down. */
function applyGlow(lines: Cell[][], row: number, glow: Glow, background: Rgb): void {
	for (let dy = -2; dy <= 2; dy++) {
		const line = lines[row + dy];
		if (!line) continue;
		const fy = [1, 0.34, 0.1][Math.abs(dy)]!;
		const w = line.length;
		for (let x = 0; x < w; x++) {
			const amount = glow.amount * fy * (0.3 - (0.17 * x) / w);
			if (amount <= 0.002) continue;
			const cell = line[x]!;
			line[x] = { ...cell, bg: mix(cell.bg ?? background, glow.color, Math.min(1, amount)) };
		}
	}
}

/**
 * Render dock v2. Same rows and rules as `renderDock`, drawn with the dock palette and animated by time:
 * spinner, turning job node, ETA shimmer, heartbeat, border sweep, glows and the finish dissolve.
 */
export function renderRichDock(all: readonly DockItem[], options: DockOptions, look: Look, paint: Paint): string[] {
	const { now, width } = options;
	const items = byImportance(all.filter((i) => isVisible(i, now)));
	if (items.length === 0) return [];
	if (width < 24) return [renderLine(items, options, paint)];

	const ctx: Ctx = { look, clock: { now, motion: !options.reducedMotion }, now };
	const iw = width - 4;
	const shown = items.length > MAX_ROWS ? items.slice(0, MAX_ROWS - 1) : items;
	const frames = shown.map((item) => rowFrame(item, iw, ctx));
	let tint: Glow | undefined;
	for (const frame of frames) {
		const amount = (frame.glow?.amount ?? 0) * frame.alpha;
		if (frame.glow && amount > (tint?.amount ?? 0)) tint = { color: frame.glow.color, amount };
	}

	const side = (x: number): Cell => ({ ch: "│", fg: borderColor(x, width, 0, look, ctx.clock, tint) });
	const sp = spaces(1, look.text);
	const rows = frames.map((f) => [
		side(0),
		...sp,
		...flatten(f.cells, f.alpha, look.background),
		...sp,
		side(width - 1),
	]);
	if (shown.length < items.length) {
		const more = cells(`+${items.length - shown.length} more · /monitors`, look.dim);
		rows.push([side(0), ...sp, ...fitCells(more, [], iw, look.text), ...sp, side(width - 1)]);
	}
	const lines = [
		topBorder(items, width, options.savedTokens, ctx, tint),
		...rows,
		bottomBorder(width, options.shortcut, ctx, tint),
	];
	if (look.tints)
		frames.forEach((frame, k) => {
			if (frame.glow && frame.glow.amount * frame.alpha > 0.003)
				applyGlow(lines, k + 1, { ...frame.glow, amount: frame.glow.amount * frame.alpha }, look.background);
		});
	return lines.map((line) => encode(line, look.mode));
}
