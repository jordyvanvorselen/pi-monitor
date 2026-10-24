// Draws one frame of the Herdr recording: Herdr's sidebar (spaces, agents and pi-monitor's rows) next to a pi
// pane with the real dock v2, and Herdr's toasts. Pure: scene in, ANSI lines out.
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countsRow, monitorRow, type HerdrPalette } from "../src/herdr/config.ts";
import { PANE_TOKEN } from "../src/herdr/tokens.ts";
import { cells, encode, type Cell } from "../src/ui/cells.ts";
import { hex, mix, smooth, type Rgb } from "../src/ui/color.ts";
import { renderRichDock } from "../src/ui/dock-rich.ts";
import { lookFor, type Look } from "../src/ui/look.ts";
import { story } from "./dock-story.ts";
import { TOAST_MS, type AgentState, type Scene } from "./herdr-story.ts";

export const COLS = 110;
export const ROWS = 26;
/** Sidebar columns, without the divider. */
export const SIDEBAR = 32;
const PANE_X = SIDEBAR + 1;
const PANE_W = COLS - PANE_X;

/** The user's Ghostty theme, CyberWave: a navy to black gradient behind the whole window, white text. */
export const GRADIENT: readonly [Rgb, Rgb] = [hex("#002633"), hex("#000000")];
/** Herdr's catppuccin theme (mocha) for the sidebar, tabs and toasts. */
const C = {
	text: hex("#cdd6f4"),
	subtext: hex("#a6adc8"),
	overlay: hex("#6c7086"),
	surface: hex("#45475a"),
	crust: hex("#11111b"),
	base: hex("#1e1e2e"),
	mauve: hex("#cba6f7"),
	pink: hex("#f5c2e7"),
	green: hex("#a6e3a1"),
	yellow: hex("#f9e2af"),
	red: hex("#f38ba8"),
	blue: hex("#89b4fa"),
};

/** Background of row `y`: Ghostty stretches the gradient image over the window. */
export function rowBackground(y: number): Rgb {
	return mix(GRADIENT[0], GRADIENT[1], (y + 0.5) / ROWS);
}

export interface Space {
	name: string;
	branch: string;
	/** Herdr's git status, e.g. `↓14`. */
	git?: string;
	/** The panes of the agents in this space. */
	panes: string[];
}

export const SPACES: readonly Space[] = [
	{ name: "webapp", branch: "feat/login-form", git: "↑3", panes: ["webapp"] },
	{ name: "Backend Tests", branch: "main", git: "↓14", panes: ["backend"] },
	{ name: "site", branch: "main", panes: ["site"] },
];
const SELECTED = 0;

type Grid = Cell[][];

function blankGrid(): Grid {
	return Array.from({ length: ROWS }, (_, y) =>
		Array.from({ length: COLS }, (): Cell => ({ ch: " ", fg: C.text, bg: rowBackground(y) })),
	);
}

/** Write `text` at x,y. Keeps the background unless one is given. Stops at `max` columns. */
function put(
	grid: Grid,
	x: number,
	y: number,
	text: string | Cell[],
	fg: Rgb,
	style: { bold?: boolean; bg?: Rgb; max?: number; ellipsis?: boolean } = {},
): number {
	const row = grid[y];
	if (!row) return x;
	let cs = typeof text === "string" ? cells(text, fg, style.bold ? { bold: true } : {}) : text;
	const end = Math.min(COLS, x + (style.max ?? COLS));
	// Herdr cuts sidebar text that does not fit with `…`.
	if (style.ellipsis && cs.length > end - x) cs = [...cs.slice(0, end - x - 1), ...cells("…", fg)];
	for (const c of cs) {
		if (x >= end || (c.wide && x + 1 >= end)) break;
		row[x] = { ...c, bg: c.bg ?? style.bg ?? row[x]!.bg };
		x++;
	}
	return x;
}

function fill(grid: Grid, x0: number, x1: number, y: number, bg: Rgb): void {
	for (let x = x0; x < x1; x++) grid[y]![x] = { ch: " ", fg: C.text, bg };
}

// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const SGR = /\x1b\[([0-9;]*)m|\x1b\]8;[^\x1b\x07]*(?:\x1b\\|\x07)/y;

/** Cells for an ANSI line as the dock writes it: 24-bit colours, bold, OSC 8 links. */
export function ansiCells(line: string, fg: Rgb): Cell[] {
	const out: Cell[] = [];
	let style: { fg: Rgb; bg: Rgb | undefined; bold: boolean } = { fg, bg: undefined, bold: false };
	let i = 0;
	let text = "";
	const flush = () => {
		if (text) out.push(...cells(text, style.fg, { bold: style.bold, ...(style.bg ? { bg: style.bg } : {}) }));
		text = "";
	};
	while (i < line.length) {
		SGR.lastIndex = i;
		const m = SGR.exec(line);
		if (!m) {
			text += line[i];
			i++;
			continue;
		}
		flush();
		i = SGR.lastIndex;
		if (m[1] === undefined) continue;
		const codes = (m[1] || "0").split(";").map(Number);
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k]!;
			if (code === 0) style = { fg, bg: undefined, bold: false };
			else if (code === 1) style.bold = true;
			else if (code === 22) style.bold = false;
			else if (code === 39) style.fg = fg;
			else if (code === 49) style.bg = undefined;
			else if ((code === 38 || code === 48) && codes[k + 1] === 2) {
				const rgb: Rgb = [codes[k + 2]!, codes[k + 3]!, codes[k + 4]!];
				if (code === 38) style.fg = rgb;
				else style.bg = rgb;
				k += 4;
			}
		}
	}
	flush();
	return out;
}

/** The colour of a pi theme role. */
export function themeRgb(theme: Theme, role: Parameters<Theme["getFgAnsi"]>[0]): Rgb {
	const m = /38;2;(\d+);(\d+);(\d+)/.exec(theme.getFgAnsi(role));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : C.text;
}

function themeBg(theme: Theme, role: Parameters<Theme["getBgAnsi"]>[0]): Rgb {
	const m = /48;2;(\d+);(\d+);(\d+)/.exec(theme.getBgAnsi(role));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : C.base;
}

/** Herdr's status dots: hollow when idle, filled and coloured otherwise. */
function stateIcon(state: AgentState | "none"): [string, Rgb] {
	if (state === "blocked") return ["●", C.red];
	if (state === "working") return ["●", C.yellow];
	if (state === "idle") return ["○", C.green];
	return ["·", C.overlay];
}

const URGENCY: Record<AgentState, number> = { blocked: 2, working: 1, idle: 0 };

/** The `$mon` row: the colour of the first rule the value starts with, like Herdr's `starts_with`. */
function monColor(value: string, palette: HerdrPalette): Rgb {
	const entry = monitorRow(palette)[0] as unknown as { rules: { starts_with: string; fg: string }[] };
	const rule = entry.rules.find((r) => value.startsWith(r.starts_with));
	return rule ? hex(rule.fg) : C.text;
}

function drawSidebar(grid: Grid, scene: Scene, palette: HerdrPalette): void {
	const right = SIDEBAR - 2;
	for (let y = 0; y < ROWS; y++) put(grid, SIDEBAR, y, "│", mix(rowBackground(y), C.surface, 0.8));
	put(grid, 2, 0, "spaces", C.overlay, { bold: true });

	const agent = (pane: string) => scene.agents.find((a) => a.pane === pane);
	SPACES.forEach((space, i) => {
		const y = 2 + i * 2;
		const selected = i === SELECTED;
		if (selected) for (const dy of [0, 1]) fill(grid, 1, right + 1, y + dy, mix(rowBackground(y + dy), C.mauve, 0.13));
		const states = space.panes.map((p) => agent(p)?.state ?? "idle");
		const top = states.sort((a, b) => URGENCY[b] - URGENCY[a])[0];
		const [icon, color] = stateIcon(top ?? "none");
		put(grid, 2, y, icon, color);
		put(grid, 4, y, space.name, selected ? C.text : C.subtext, { bold: selected, max: right - 4 });
		const x = put(grid, 4, y + 1, space.branch, selected ? C.mauve : C.overlay, { max: right - 4 });
		if (space.git) put(grid, x + 1, y + 1, space.git, C.pink);
	});

	put(grid, 2, 9, "new", C.overlay);
	put(grid, right - 5, 9, "●", C.mauve);
	put(grid, right - 3, 9, "menu", C.overlay);
	put(grid, 1, 10, "─".repeat(right), mix(rowBackground(10), C.surface, 0.9));
	put(grid, 2, 11, "agents", C.overlay, { bold: true });
	put(grid, right - 6, 11, "grouped", C.overlay, { bold: true });

	// Herdr's default agent rows, then pi-monitor's: `$mon` and the counts row. Empty rows are left out.
	const counts = countsRow(palette) as { token: string; fg: string }[];
	let y = 13;
	for (const space of SPACES)
		for (const pane of space.panes) {
			const a = agent(pane);
			if (!a || y >= ROWS - 1) continue;
			const [icon, color] = stateIcon(a.state);
			put(grid, 2, y, icon, color);
			const x = put(grid, 4, y, space.name, C.text, { max: right - 4 });
			put(grid, x, y, " · 1", C.overlay, { max: right - x + 1 });
			put(grid, 4, ++y, "pi", C.overlay);
			const mon = a.tokens[PANE_TOKEN];
			if (mon) put(grid, 4, ++y, mon, monColor(mon, palette), { max: right - 3, ellipsis: true });
			const parts = counts
				.map((c) => ({ value: a.tokens[c.token.slice(1)], fg: hex(c.fg) }))
				.filter((p): p is { value: string; fg: Rgb } => !!p.value);
			if (parts.length) {
				y++;
				let x = 4;
				parts.forEach((p, k) => {
					if (k) x = put(grid, x, y, " · ", C.overlay);
					x = put(grid, x, y, p.value, p.fg);
				});
			}
			y += 2;
		}
	put(grid, right, ROWS - 1, "«", C.overlay);
}

/** The end of the conversation in the webapp pi, above the dock. */
const CHAT: { text: string; kind: "user" | "assistant" | "tool" | "toolOut" | "blank" | "pad" }[] = [
	{ kind: "assistant", text: "Added LoginForm with validation and a session hook. The tests pass:" },
	{ kind: "blank", text: "" },
	{ kind: "tool", text: "$ yarn test src/auth" },
	{ kind: "toolOut", text: "✓ 14 passed (1.2s)" },
	{ kind: "blank", text: "" },
	{ kind: "assistant", text: "The form posts to /api/login and keeps the session in a cookie." },
	{ kind: "blank", text: "" },
	{ kind: "pad", text: "" },
	{ kind: "user", text: "Ship it: open a PR, keep yarn dev running and watch CI." },
	{ kind: "pad", text: "" },
	{ kind: "blank", text: "" },
	{ kind: "tool", text: "$ gh pr create --fill --base main" },
	{ kind: "toolOut", text: "https://github.com/acme/app/pull/42" },
	{ kind: "blank", text: "" },
	{ kind: "assistant", text: "Opened PR #42. CI #42 and yarn dev run as monitors now, so I hear about" },
	{ kind: "assistant", text: "a failure the moment it happens, without polling." },
];

/** Braille spinner of pi's loader. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function drawPane(grid: Grid, scene: Scene, theme: Theme, looks: (bg: Rgb) => Look): void {
	// Herdr's tab bar.
	fill(grid, PANE_X, COLS, 0, mix(rowBackground(0), C.crust, 0.6));
	fill(grid, PANE_X + 1, PANE_X + 9, 0, C.mauve);
	put(grid, PANE_X + 4, 0, "1", C.base, { bold: true });
	put(grid, PANE_X + 11, 0, "+", C.overlay);

	const x = PANE_X + 1;
	const width = PANE_W - 2;
	let y = ROWS - 1;
	// pi's footer and editor.
	put(grid, x, y--, "~/code/webapp (feat/login-form)", themeRgb(theme, "dim"));
	const border = themeRgb(theme, "borderMuted");
	put(grid, x, y--, "─".repeat(width), border);
	put(grid, x, y, " ", C.text, { bg: themeRgb(theme, "text") });
	y--;
	put(grid, x, y--, "─".repeat(width), border);

	// The dock, with the colours pi gives it, on the background behind it.
	const { now, items, savedTokens } = story(scene.ms);
	const look = looks(rowBackground(y - 2));
	const dock = renderRichDock(
		items,
		{ width, now, frame: 0, savedTokens, shortcut: "ctrl+shift+m", reducedMotion: false },
		look,
		theme,
	);
	for (const line of dock.toReversed()) put(grid, x, y--, ansiCells(line, look.text), look.text);

	// pi's working loader while the webapp pi fixes the test, then the conversation, scrolled to its end.
	const webapp = scene.agents.find((a) => a.pane === "webapp");
	if (webapp?.state === "working") {
		const spin = SPINNER[Math.floor(scene.ms / 80) % SPINNER.length]!;
		const after = put(grid, x, y, spin, themeRgb(theme, "accent"));
		put(grid, after + 1, y, "Working...", themeRgb(theme, "muted"));
	}
	y -= 2;
	const userBg = themeBg(theme, "userMessageBg");
	const toolBg = themeBg(theme, "toolSuccessBg");
	for (const line of CHAT.toReversed()) {
		if (y < 1) break;
		if (line.kind === "user" || line.kind === "pad") {
			fill(grid, x, x + width, y, userBg);
			put(grid, x + 1, y, line.text, themeRgb(theme, "userMessageText"));
		} else if (line.kind === "tool" || line.kind === "toolOut") {
			fill(grid, x, x + width, y, toolBg);
			const color = themeRgb(theme, line.kind === "tool" ? "toolTitle" : "toolOutput");
			put(grid, x + 1, y, line.text, color, { bold: line.kind === "tool" });
		} else put(grid, x, y, line.text, themeRgb(theme, "text"));
		y--;
	}
}

/** Herdr toasts, bottom right, sliding in and out. The newest at the bottom. */
function drawToasts(grid: Grid, scene: Scene, palette: HerdrPalette): void {
	let bottom = ROWS - 1;
	for (const toast of scene.toasts.toReversed()) {
		const w = Math.max(visibleWidth(toast.title), visibleWidth(toast.body)) + 4;
		const shown = smooth(Math.min(1, toast.age / 220, (TOAST_MS - toast.age) / 260));
		const x = COLS - 1 - Math.round(shown * (w + 1));
		const color = hex(toast.status === "success" ? palette.ok : palette.failed);
		const bg = mix(rowBackground(bottom), C.base, 0.75);
		const top = bottom - 3;
		for (let y = top; y <= bottom; y++) fill(grid, Math.max(x, PANE_X), Math.min(COLS, x + w), y, bg);
		const clip = (cx: number) => ({ max: Math.max(0, COLS - cx), bg });
		put(grid, x, top, `╭${"─".repeat(w - 2)}╮`, color, clip(x));
		put(grid, x, top + 1, "│", color, clip(x));
		put(grid, x + 2, top + 1, toast.title, color, { ...clip(x + 2), bold: true });
		put(grid, x + w - 1, top + 1, "│", color, clip(x + w - 1));
		put(grid, x, top + 2, "│", color, clip(x));
		put(grid, x + 2, top + 2, toast.body, C.subtext, clip(x + 2));
		put(grid, x + w - 1, top + 2, "│", color, clip(x + w - 1));
		put(grid, x, bottom, `╰${"─".repeat(w - 2)}╯`, color, clip(x));
		bottom = top - 1;
	}
}

export interface ViewOptions {
	theme: Theme;
	palette: HerdrPalette;
}

export interface Frame {
	/** ROWS lines of exactly COLS columns. */
	lines: string[];
	/** One key per cell, row by row, that changes when the cell looks different. */
	keys: string[];
}

/** One frame of the recording. */
export function renderHerdr(scene: Scene, { theme, palette }: ViewOptions): Frame {
	const grid = blankGrid();
	const looks = new Map<string, Look>();
	const lookAt = (bg: Rgb) => {
		const key = bg.map(Math.round).join(",");
		if (!looks.has(key)) looks.set(key, lookFor(theme, { background: bg.map(Math.round) as unknown as Rgb })!);
		return looks.get(key)!;
	};
	drawSidebar(grid, scene, palette);
	drawPane(grid, scene, theme, lookAt);
	drawToasts(grid, scene, palette);
	// The cell as the terminal gets it: colours after fading, bold, the character.
	const keys = grid.flatMap((row) => row.map((c) => `${c.ch}|${encode([c], "truecolor")}`));
	return { lines: grid.map((row) => encode(row, "truecolor")), keys };
}
