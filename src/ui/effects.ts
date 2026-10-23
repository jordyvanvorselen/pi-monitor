// The animated pieces of dock v2. Pure functions of data and time, so a frame can be tested.
import { formatShortDuration } from "../format.ts";
import { BEAT_MERGE_MS, type Beat } from "../registry.ts";
import type { Job } from "../sources/types.ts";
import { type Cell, cells, type ColorMode, gradient, spaces } from "./cells.ts";
import { clamp, mix, PALETTE, type Rgb } from "./color.ts";
import { SPINNER } from "./glyphs.ts";

const { teal, indigo, red, gold, white } = PALETTE;

/** Colours the dock draws with. Text tones come from the Pi theme, accents from the dock palette. */
export interface Look {
	mode: ColorMode;
	/** Terminal background, used to fade things out and to tint around a row. */
	background: Rgb;
	text: Rgb;
	muted: Rgb;
	dim: Rgb;
	faint: Rgb;
	output: Rgb;
	warning: Rgb;
	/** Background tints (glow, ETA track) look right. Off for 256-colour terminals. */
	tints: boolean;
}

/** Time drives every animation. `motion: false` freezes all of them (reducedMotion). */
export interface Clock {
	now: number;
	motion: boolean;
}

/** Animation phase in seconds. Frozen at 0 without motion. */
export function phase(clock: Clock): number {
	return clock.motion ? clock.now / 1000 : 0;
}

/** The braille spinner turns 12 times a second. */
export const SPINNER_MS = 1000 / 12;

export function spinnerGlyph(clock: Clock): string {
	return clock.motion ? SPINNER[Math.floor(clock.now / SPINNER_MS) % SPINNER.length]! : "◉";
}

/* ───────────── heartbeat (braille ECG) ───────────── */

/** The trace scrolls one braille dot column per this many ms (8 per second), one beat merge window. */
export const ECG_DOT_MS = BEAT_MERGE_MS;

/**
 * QRS complex drawn on the 2×4 braille dot grid (rows 0-3, baseline on row 2), one entry per dot column:
 * Q dip, sharp R spike, S dip, then a low T bump.
 */
const BEAT_SHAPE = [[3], [1, 2], [0], [1, 2], [3], [2], [1], [1]];
const BLIP_SHAPE = [[3], [1, 2], [1], [2], [2], [2], [1], [2]];
/** Braille dot bits by [column in cell][row]. */
const DOT = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];

function lowerBound(beats: readonly Beat[], at: number): number {
	let lo = 0;
	let hi = beats.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (beats[mid]!.at < at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The newest beat at or before `now`. */
export function lastBeat(beats: readonly Beat[] | undefined, now: number): Beat | undefined {
	if (!beats?.length) return undefined;
	const i = lowerBound(beats, now + 1) - 1;
	return i >= 0 ? beats[i] : undefined;
}

/** Dot rows lit in each dot column of the window that ends at `now`. `undefined` = before `start`. */
export function ecgColumns(
	beats: readonly Beat[],
	now: number,
	dotColumns: number,
	start = -Infinity,
): ({ rows: number[]; peak: number } | undefined)[] {
	const head = Math.floor(now / ECG_DOT_MS);
	const out: ({ rows: number[]; peak: number } | undefined)[] = [];
	for (let x = 0; x < dotColumns; x++) {
		const j = head - (dotColumns - 1 - x);
		if ((j + 1) * ECG_DOT_MS <= start) {
			out.push(undefined);
			continue;
		}
		const rows = new Set<number>();
		let peak = 0;
		for (let i = lowerBound(beats, (j - BEAT_SHAPE.length) * ECG_DOT_MS); i < beats.length; i++) {
			const beat = beats[i]!;
			if (beat.at >= (j + 1) * ECG_DOT_MS) break;
			const offset = j - Math.floor(beat.at / ECG_DOT_MS);
			if (offset < 0 || offset >= BEAT_SHAPE.length) continue;
			const big = beat.amp >= 0.7;
			for (const r of (big ? BEAT_SHAPE : BLIP_SHAPE)[offset]!) rows.add(r);
			if (offset >= 1 && offset <= 3) peak = Math.max(peak, big ? 1 : 0.5);
		}
		if (rows.size === 0) rows.add(2);
		out.push({ rows: [...rows], peak });
	}
	return out;
}

/** Braille characters of the trace, without colour. Blank where the monitor had not started yet. */
export function ecgText(beats: readonly Beat[], now: number, width: number, start?: number): string {
	return ecgCells(beats, now, width, PLAIN_LOOK, { now, motion: false }, start)
		.map((c) => c.ch)
		.join("");
}

const PLAIN_LOOK: Look = {
	mode: "truecolor",
	background: PALETTE.background,
	text: PALETTE.text,
	muted: PALETTE.text,
	dim: PALETTE.text,
	faint: PALETTE.text,
	output: PALETTE.text,
	warning: gold,
	tints: false,
};

/**
 * Heartbeat strip: flat baseline, a QRS blip per arriving line, newest on the right. The head is
 * bright teal with a hot white tip when a line just arrived, the tail fades through indigo into the background.
 */
export function ecgCells(
	beats: readonly Beat[],
	now: number,
	width: number,
	look: Look,
	clock: Clock,
	start?: number,
): Cell[] {
	const columns = ecgColumns(beats, now, width * 2, start);
	const recent = lastBeat(beats, now);
	const hot = clock.motion && recent ? clamp(1 - (now - recent.at) / 450) : 0;
	const ghost = 0.14;
	const out: Cell[] = [];
	for (let c = 0; c < width; c++) {
		let bits = 0;
		let peak = 0;
		let any = false;
		for (let d = 0; d < 2; d++) {
			const col = columns[c * 2 + d];
			if (!col) continue;
			any = true;
			peak = Math.max(peak, col.peak);
			for (const r of col.rows) bits |= DOT[d]![r]!;
		}
		if (!any) {
			out.push({ ch: " ", fg: look.dim });
			continue;
		}
		const k = (c + 1) / width; // 0 = tail, 1 = head
		const intensity = ghost + (1 - ghost) * k ** 1.7;
		let hue = mix(indigo, teal, k ** 0.6);
		hue = mix(hue, white, Math.min(0.4, peak * 0.28) * k);
		let fg = mix(look.background, hue, intensity);
		const isHead = c === width - 1;
		if (isHead) fg = mix(fg, white, 0.35 + hot * 0.4);
		const bg = isHead && hot > 0 && look.tints ? mix(look.background, teal, 0.28 * hot) : undefined;
		out.push({ ch: String.fromCharCode(0x2800 + bits), fg, bold: isHead, ...(bg ? { bg } : {}) });
	}
	return out;
}

/* ───────────── job track ───────────── */

export function jobCountText(jobs: readonly Job[]): { text: string; failed: boolean } {
	const done = jobs.filter((j) => j.state === "success" || j.state === "failure" || j.state === "skipped").length;
	const failed = jobs.some((j) => j.state === "failure");
	return { text: `${done}/${jobs.length}`, failed };
}

/**
 * Job track `●━━●━━◐┄┄○`: gradient teal → indigo over finished jobs, a turning gold node for the running
 * job with a glint travelling along its link. Long tracks use one-cell links, very long ones `12/19`.
 */
export function trackCells(jobs: readonly Job[], maxWidth: number, look: Look, clock: Clock): Cell[] {
	if (jobs.length === 0) return [];
	const T = phase(clock);
	const ok = (i: number) => mix(teal, indigo, (i / Math.max(1, jobs.length - 1)) * 0.6);
	for (const linkWidth of [2, 1]) {
		if (jobs.length + (jobs.length - 1) * linkWidth > maxWidth) continue;
		const out: Cell[] = [];
		jobs.forEach((job, i) => {
			if (job.state === "success") out.push(...cells("●", ok(i)));
			else if (job.state === "failure") out.push(...cells("✗", red, { bold: true }));
			else if (job.state === "running") {
				const glyph = clock.motion ? "◐◓◑◒"[Math.floor(T * 6) % 4]! : "◐";
				out.push(...cells(glyph, mix(gold, white, 0.15 + 0.15 * Math.sin(T * 6)), { bold: true }));
			} else if (job.state === "skipped") out.push(...cells("◌", look.dim));
			else out.push(...cells("○", look.dim));
			if (i === jobs.length - 1) return;
			for (let k = 0; k < linkWidth; k++) {
				if (job.state === "success")
					out.push(...cells("━", mix(look.background, mix(ok(i), ok(i + 1), (k + 1) / 3), 0.62)));
				else if (job.state === "skipped") out.push(...cells("━", look.faint));
				else if (job.state === "running") {
					const glint = clock.motion && Math.floor(T * 5) % 4 === k;
					out.push(...cells("┄", glint ? mix(gold, white, 0.2) : mix(look.background, gold, 0.35)));
				} else if (job.state === "failure") out.push(...cells("┄", mix(look.background, red, 0.45)));
				else out.push(...cells("┄", look.faint));
			}
		});
		return out;
	}
	const { text, failed } = jobCountText(jobs);
	return cells(text, failed ? red : look.muted);
}

/* ───────────── ETA bar ───────────── */

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Smooth ETA bar: eighth blocks over a recessed track, gold → teal, with a slow shimmer.
 * Then `~3m` left, `+1m` overtime, or `done`.
 */
export function etaCells(
	elapsedMs: number,
	etaMs: number,
	width: number,
	look: Look,
	clock: Clock,
	state: { failing?: boolean; done?: boolean } = {},
): Cell[] {
	const fill = clamp(elapsedMs / etaMs) * width;
	const full = Math.floor(fill);
	const track = look.tints ? mix(look.background, look.text, 0.07) : undefined;
	const sweep = clock.motion ? (((clock.now / 1000) % 3.2) / 3.2) * (width + 8) - 4 : -100;
	const out: Cell[] = [];
	for (let i = 0; i < width; i++) {
		let c = mix(gold, teal, i / Math.max(1, width - 1));
		if (state.failing) c = mix(c, red, 0.65);
		c = mix(c, white, Math.exp(-(((i - sweep) / 1.6) ** 2)) * 0.35);
		const bg = track ? { bg: track } : {};
		if (i < full) out.push({ ch: "█", fg: c, ...bg });
		else if (i === full && fill - full > 0.06)
			out.push({ ch: EIGHTHS[Math.max(1, Math.floor((fill - full) * 8))]!, fg: c, ...bg });
		else out.push(track ? { ch: " ", fg: c, bg: track } : { ch: "·", fg: look.faint });
	}
	if (state.done) return [...out, ...spaces(1, look.text), ...cells("done", teal)];
	const left = etaMs - elapsedMs;
	const label = left >= 0 ? `~${formatShortDuration(left)}` : `+${formatShortDuration(-left)}`;
	return [...out, ...spaces(1, look.text), ...cells(label, left >= 0 ? look.muted : gold)];
}

/* ───────────── small pieces ───────────── */

/** `pi is on it ↳` with a gentle teal ↔ indigo shimmer. */
export function handlingCells(clock: Clock, text = "pi is on it ↳"): Cell[] {
	const T = phase(clock);
	return gradient(text, (i) => mix(teal, indigo, 0.5 + 0.5 * Math.sin(T * 3 - i * 0.45)));
}

/** `monitors` in a shimmering teal → indigo gradient. */
export function titleCells(clock: Clock): Cell[] {
	const T = phase(clock);
	return gradient("monitors", (i) => mix(teal, indigo, 0.5 + 0.5 * Math.sin(T * 1.3 - i * 0.42)), { bold: true });
}

/** A glow behind a row: a colour and how strong it is right now. */
export interface Glow {
	color: Rgb;
	amount: number;
}

/**
 * Border colour at column `i` of `width`: teal → indigo, faded into the background. A soft light sweeps
 * along the top border (`row` 1) and back along the bottom (`row` -1) every 6 seconds. A glow tints it.
 */
export function borderColor(i: number, width: number, row: -1 | 0 | 1, look: Look, clock: Clock, tint?: Glow): Rgb {
	let c = mix(teal, indigo, i / Math.max(1, width - 1));
	let sheen = 0;
	if (row !== 0 && clock.motion) {
		const p = ((clock.now / 1000) % 6) / 1.8;
		if (p < 1) {
			const x = row > 0 ? p * (width + 24) - 12 : width - (p * (width + 24) - 12);
			sheen = Math.exp(-(((i - x) / 6) ** 2)) * (row > 0 ? 0.6 : 0.35);
		}
	}
	c = mix(c, white, sheen * 0.45);
	if (tint) c = mix(c, tint.color, clamp(tint.amount * 0.6));
	return mix(look.background, c, 0.36 + sheen * 0.5 + (tint ? clamp(tint.amount) * 0.22 : 0));
}
