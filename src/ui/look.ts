// The colours dock v2 draws with, taken from the Pi theme and the terminal wherever they exist.
import { type Color, colorToRgb } from "@earendil-works/pi-tui";
import type { ColorMode } from "./cells.ts";
import { LIGHT_PALETTE, lightness, mix, PALETTE, type Palette, type Rgb, readable } from "./color.ts";

/**
 * Colour roles. The dock palette (teal, indigo, red, gold) maps to theme tokens:
 * `success` (teal), `link` (indigo), `error` (red), `warning` (gold). `border` ends the border gradient.
 */
export interface Look {
	mode: ColorMode;
	/** The background is light: highlights darken instead of going white, glows are softer. */
	light: boolean;
	/** Terminal background, used to fade things out and to tint around a row. */
	background: Rgb;
	text: Rgb;
	muted: Rgb;
	dim: Rgb;
	faint: Rgb;
	output: Rgb;
	success: Rgb;
	link: Rgb;
	error: Rgb;
	warning: Rgb;
	border: Rgb;
	/** The strongest contrast: near-white on dark backgrounds, near-black on light ones. Hot tips and glints. */
	highlight: Rgb;
	/** Background tints (glow, ETA track) look right. Off for 256-colour terminals. */
	tints: boolean;
	/** Glow strength. Lower on light backgrounds so tinted rows keep their contrast. */
	glow: number;
}

/** The parts of Pi's `Theme` that tell how to draw in colour. */
export interface ThemeColors {
	getColorMode?(): ColorMode;
	readonly appearance?: "dark" | "light";
	readonly colors?: Readonly<Record<string, Color>>;
}

/** What the terminal reported about itself. */
export interface TerminalReport {
	background?: Rgb | undefined;
	/** The 16 ANSI colours, so theme colours given as palette indexes resolve to what the terminal shows. */
	palette?: readonly (Rgb | undefined)[] | undefined;
}

/** Theme tokens tried in order for each role. */
export const ROLE_TOKENS = {
	success: ["success"],
	link: ["mdLink", "border", "accent"],
	error: ["error"],
	warning: ["warning"],
	border: ["border", "mdLink", "accent"],
	text: ["text"],
	muted: ["muted"],
	dim: ["dim"],
	output: ["toolOutput"],
} as const;

/** Accents must reach this contrast against the background (WCAG for UI parts and large text). */
export const MIN_CONTRAST = 3;

/**
 * The look for a theme, or undefined when the dock should use the plain theme rendering:
 * a theme that cannot report its colour mode or concrete colours.
 */
export function lookFor(theme: ThemeColors, terminal: TerminalReport = {}): Look | undefined {
	let mode: ColorMode | undefined;
	let colors: Readonly<Record<string, Color>> | undefined;
	try {
		mode = theme.getColorMode?.();
		colors = theme.colors;
	} catch {
		return undefined;
	}
	if (mode !== "truecolor" && mode !== "256color") return undefined;

	const light = terminal.background ? lightness(terminal.background) > 0.5 : theme.appearance === "light";
	const fallback: Palette = light ? LIGHT_PALETTE : PALETTE;
	const background = terminal.background ?? fallback.background;
	const token = (names: readonly string[]): Rgb | undefined => {
		for (const name of names) {
			const color = colors?.[name];
			if (!color) continue;
			if (color.kind === "indexed" && color.index < 16) {
				const reported = terminal.palette?.[color.index];
				if (reported) return reported;
			}
			const { r, g, b } = colorToRgb(color);
			return [r, g, b];
		}
		return undefined;
	};

	const text = token(ROLE_TOKENS.text) ?? fallback.text;
	const highlight = light ? mix(text, PALETTE.black, 0.5) : PALETTE.white;
	const accent = (names: readonly string[], own: Rgb) =>
		readable(token(names) ?? own, background, light ? PALETTE.black : PALETTE.white, MIN_CONTRAST);
	const link = accent(ROLE_TOKENS.link, fallback.indigo);
	const dim = token(ROLE_TOKENS.dim) ?? mix(background, text, 0.3);
	return {
		mode,
		light,
		background,
		text,
		muted: token(ROLE_TOKENS.muted) ?? mix(background, text, 0.56),
		dim,
		faint: mix(background, dim, 0.55),
		output: token(ROLE_TOKENS.output) ?? mix(background, text, 0.8),
		success: accent(ROLE_TOKENS.success, fallback.teal),
		link,
		error: accent(ROLE_TOKENS.error, fallback.red),
		warning: accent(ROLE_TOKENS.warning, fallback.gold),
		border: token(ROLE_TOKENS.border) ?? link,
		highlight,
		tints: mode === "truecolor",
		glow: light ? 0.6 : 1,
	};
}

/** The look of the launch video: built-in palette on its dark background. For text-only helpers and tests. */
export const VIDEO_LOOK: Look = {
	mode: "truecolor",
	light: false,
	background: PALETTE.background,
	text: PALETTE.text,
	muted: mix(PALETTE.background, PALETTE.text, 0.56),
	dim: mix(PALETTE.background, PALETTE.text, 0.3),
	faint: mix(PALETTE.background, PALETTE.text, 0.16),
	output: mix(PALETTE.background, PALETTE.text, 0.8),
	success: PALETTE.teal,
	link: PALETTE.indigo,
	error: PALETTE.red,
	warning: PALETTE.gold,
	border: PALETTE.indigo,
	highlight: PALETTE.white,
	tints: true,
	glow: 1,
};
