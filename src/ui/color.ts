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

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(c: Rgb): number {
	const lin = (v: number) => {
		const s = clamp(v / 255);
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** `c`, pushed toward `toward` just enough to reach `min` contrast against `background`. */
export function readable(c: Rgb, background: Rgb, toward: Rgb, min = 3): Rgb {
	for (let t = 0; t <= 1; t += 0.05) {
		const candidate = mix(c, toward, t);
		if (contrast(candidate, background) >= min) return candidate;
	}
	return toward;
}

export type Palette = Readonly<Record<"teal" | "indigo" | "red" | "gold" | "background" | "text", Rgb>>;

/** The dock v2 palette, the same as in the launch video. For dark backgrounds. */
export const PALETTE = {
	teal: hex("#3CF2C8"),
	indigo: hex("#7C8CFF"),
	red: hex("#FF5F6D"),
	gold: hex("#FFD66B"),
	white: [255, 255, 255] as Rgb,
	black: [0, 0, 0] as Rgb,
	/** Assumed terminal background until the terminal reports its own. */
	background: hex("#0B0E14"),
	text: hex("#EEF2F5"),
} as const;

/** The same hues, deep enough to read on a light background. Used when the theme has no colour for a role. */
export const LIGHT_PALETTE: Palette = {
	teal: hex("#008F72"),
	indigo: hex("#4652D6"),
	red: hex("#D42A3C"),
	gold: hex("#A86E00"),
	background: hex("#FFFFFF"),
	text: hex("#23262B"),
};
