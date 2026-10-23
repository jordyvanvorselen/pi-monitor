// Colour math for the dock. Colours are `[r, g, b]` with channels 0-255 (fractions allowed while mixing).

export type Rgb = readonly [number, number, number];

export function hex(value: string): Rgb {
	const n = Number.parseInt(value.replace(/^#/, ""), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function clamp(x: number, lo = 0, hi = 1): number {
	return x < lo ? lo : x > hi ? hi : x;
}

/** Smoothstep from 0 to 1. Values outside 0-1 are clamped. */
export function smooth(x: number): number {
	const t = clamp(x);
	return t * t * (3 - 2 * t);
}

/** Linear blend: `t = 0` gives `a`, `t = 1` gives `b`. `t` is clamped to 0-1. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	const k = clamp(t);
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Rounded and clamped to whole channels, packed into one number for cheap comparisons. */
export function pack(c: Rgb): number {
	const ch = (v: number) => clamp(Math.round(v), 0, 255);
	return (ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2]);
}

/** Relative lightness 0-1 (Rec. 709 weights), enough to tell a dark background from a light one. */
export function lightness(c: Rgb): number {
	return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/** The dock v2 palette, the same as in the launch video. */
export const PALETTE = {
	teal: hex("#3CF2C8"),
	indigo: hex("#7C8CFF"),
	red: hex("#FF5F6D"),
	gold: hex("#FFD66B"),
	white: [255, 255, 255] as Rgb,
	/** Assumed terminal background until the terminal reports its own. */
	background: hex("#0B0E14"),
	text: hex("#EEF2F5"),
} as const;
