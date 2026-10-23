// A line as an array of terminal cells, so every cell can get its own colour and lines can be
// blended, faded and tinted before they turn into ANSI text.
import { foregroundAnsi, backgroundAnsi, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { mix, pack, type Rgb } from "./color.ts";

export type ColorMode = "truecolor" | "256color";

export interface Cell {
	/** One grapheme. `""` marks the second column of a wide grapheme. */
	ch: string;
	fg: Rgb;
	bg?: Rgb | undefined;
	bold?: boolean | undefined;
	/** OSC 8 hyperlink target. */
	link?: string | undefined;
	/** Wide grapheme: the next cell is its continuation. */
	wide?: boolean | undefined;
	/** Opacity of the text while dissolving, 0-1. */
	fade?: number | undefined;
}

export interface CellStyle {
	bold?: boolean;
	bg?: Rgb;
	link?: string;
}

const segmenter = new Intl.Segmenter();
// eslint-disable-next-line no-control-regex -- control characters would break the cell grid
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Cells for `text`, one per column. Control characters are dropped, wide graphemes take two cells. */
export function cells(text: string, fg: Rgb, style: CellStyle = {}): Cell[] {
	const out: Cell[] = [];
	for (const { segment } of segmenter.segment(text.replace(CONTROL, ""))) {
		const w = visibleWidth(segment);
		if (w <= 0) continue;
		out.push({ ch: segment, fg, ...style, ...(w > 1 ? { wide: true } : {}) });
		for (let i = 1; i < w; i++) out.push({ ch: "", fg, ...style });
	}
	return out;
}

/** Per-grapheme colour: `color(i, n)` for the i-th of n graphemes. */
export function gradient(text: string, color: (i: number, n: number) => Rgb, style: CellStyle = {}): Cell[] {
	const parts = [...segmenter.segment(text)].map((s) => s.segment);
	return parts.flatMap((part, i) => cells(part, color(i, parts.length), style));
}

export function spaces(n: number, fg: Rgb): Cell[] {
	return Array.from({ length: Math.max(0, n) }, () => ({ ch: " ", fg }));
}

/** Pad with spaces to at least `n` columns. */
export function padCells(cs: Cell[], n: number, fg: Rgb): Cell[] {
	return cs.length >= n ? cs : [...cs, ...spaces(n - cs.length, fg)];
}

/** Cut to `max` columns, ending in `…` when something was cut. Never splits a wide grapheme. */
export function truncCells(cs: readonly Cell[], max: number, ellipsis: Rgb): Cell[] {
	if (cs.length <= max) return [...cs];
	if (max <= 0) return [];
	const out = cs.slice(0, max - 1);
	const last = out[out.length - 1];
	if (last?.wide) out[out.length - 1] = { ...last, ch: " ", wide: undefined };
	out.push({ ch: "…", fg: ellipsis });
	return out;
}

/** `left` …padding… `right`, exactly `width` columns. Drops `right` when it does not fit. */
export function fitCells(left: readonly Cell[], right: readonly Cell[], width: number, fg: Rgb): Cell[] {
	const keepRight = right.length > 0 && right.length + 4 <= width;
	const room = keepRight ? width - right.length - 2 : width;
	const head = truncCells(left, room, fg);
	if (!keepRight) return padCells(head, width, fg);
	return [...head, ...spaces(width - head.length - right.length, fg), ...right];
}

/**
 * Dissolve line `a` into line `b` (same width), sweeping from right to left as `p` goes 0 → 1.
 * Cells with the same character blend their colour; others fade out and the new one fades in.
 */
export function morph(a: readonly Cell[], b: readonly Cell[], p: number): Cell[] {
	const n = a.length;
	return a.map((from, i) => {
		const to = b[i] ?? from;
		const start = 0.55 * (1 - i / Math.max(1, n - 1));
		const t = (p - start) / 0.45;
		const q = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
		if (from.ch === to.ch) return { ...to, fg: mix(from.fg, to.fg, q), bold: q < 0.5 ? from.bold : to.bold };
		return q < 0.5 ? { ...from, fade: 1 - q * 2 } : { ...to, fade: q * 2 - 1 };
	});
}

/** A wide grapheme may only survive with its continuation cell right after it. */
function sanitize(cs: readonly Cell[]): Cell[] {
	return cs.map((c, i) => {
		if (c.wide && cs[i + 1]?.ch !== "") return { ...c, ch: " ", wide: undefined };
		if (c.ch === "" && !cs[i - 1]?.wide) return { ...c, ch: " " };
		return c;
	});
}

/** Fade text into `background` by `alpha` (row fade-in and fade-out) and apply `fade` from a dissolve. */
export function flatten(cs: readonly Cell[], alpha: number, background: Rgb): Cell[] {
	return sanitize(cs).map((c) => {
		const a = alpha * (c.fade ?? 1);
		if (a >= 1) return c;
		const under = c.bg ?? background;
		return { ...c, fg: mix(under, c.fg, a), bold: c.bold && a > 0.5, fade: undefined };
	});
}

const ansiCache = new Map<string, string>();

function sgr(kind: "fg" | "bg", c: Rgb, mode: ColorMode): string {
	const key = `${kind}${mode}${pack(c)}`;
	let code = ansiCache.get(key);
	if (code === undefined) {
		const color = rgbColor(...unpacked(pack(c)));
		code = kind === "fg" ? foregroundAnsi(color, mode) : backgroundAnsi(color, mode);
		if (ansiCache.size > 4096) ansiCache.clear();
		ansiCache.set(key, code);
	}
	return code;
}

function unpacked(n: number): [number, number, number] {
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const LINK_CLOSE = "\x1b]8;;\x1b\\";

/** Turn cells into one ANSI line. Only changes are emitted. Ends with a full reset. */
export function encode(cs: readonly Cell[], mode: ColorMode): string {
	let out = "";
	let fg: number | undefined;
	let bg: number | undefined;
	let bold = false;
	let link: string | undefined;
	for (const c of sanitize(cs)) {
		if (c.ch === "") continue;
		if (c.link !== link) {
			if (link) out += LINK_CLOSE;
			if (c.link) out += `\x1b]8;;${c.link}\x1b\\`;
			link = c.link;
		}
		const cellBg = c.bg ? pack(c.bg) : undefined;
		if (cellBg !== bg) {
			out += c.bg ? sgr("bg", c.bg, mode) : "\x1b[49m";
			bg = cellBg;
		}
		if (c.ch !== " ") {
			const cellFg = pack(c.fg);
			if (cellFg !== fg) {
				out += sgr("fg", c.fg, mode);
				fg = cellFg;
			}
			if (!!c.bold !== bold) {
				bold = !!c.bold;
				out += bold ? "\x1b[1m" : "\x1b[22m";
			}
		}
		out += c.ch;
	}
	if (link) out += LINK_CLOSE;
	return `${out}\x1b[0m`;
}

/** Plain text of a line, for tests and debugging. */
export function cellText(cs: readonly Cell[]): string {
	return cs.map((c) => c.ch).join("");
}
