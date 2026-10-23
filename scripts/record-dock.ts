// Record the README animation of the dock: renders the real dock v2 for every frame of the scripted story
// (scripts/dock-story.ts) with Pi's dark theme, writes an asciicast and turns it into docs/dock.gif with agg.
//
//   brew install agg        (or: cargo install --git https://github.com/asciinema/agg)
//   npm run record:dock
//
// Set AGG to use another agg binary. The intermediate cast goes to the OS temp directory.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRichDock } from "../src/ui/dock-rich.ts";
import type { Rgb } from "../src/ui/color.ts";
import { lookFor } from "../src/ui/look.ts";
import { LOOP_MS, story } from "./dock-story.ts";
import { piTheme } from "./pi-theme.ts";

const COLS = 112;
const ROWS = 7;
const FPS = 15;
/** Terminal background of the recording: a dark blue-grey that suits Pi's dark theme. */
const BACKGROUND: Rgb = [16, 18, 24];
/** Hack and DejaVu draw braille with big dots, close to what terminals like Ghostty and kitty draw themselves. */
const FONTS = "Hack Nerd Font Mono,Hack,DejaVu Sans Mono,JetBrains Mono,Fira Code,Menlo";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ?? join(root, "docs", "dock.gif");

const theme = piTheme("dark");
const look = lookFor(theme, { background: BACKGROUND });
if (!look) throw new Error("Pi's dark theme gave no colour look");

const hex = (c: readonly number[]) => c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const width = COLS - 2;
const events: [number, "o", string][] = [];
for (let frame = 0; frame < (LOOP_MS / 1000) * FPS; frame++) {
	const ms = (frame * 1000) / FPS;
	const { now, items, savedTokens } = story(ms);
	const dock = renderRichDock(
		items,
		{ width, now, frame: 0, savedTokens, shortcut: "ctrl+shift+m", reducedMotion: false },
		look,
		theme,
	);
	// Bottom-anchored like the real widget above the editor, one blank row below.
	const screen = [...Array<string>(Math.max(0, ROWS - 1 - dock.length)).fill(""), ...dock, ""];
	const text = screen.map((line) => `\x1b[2K ${line}`).join("\r\n");
	events.push([ms / 1000, "o", `${frame === 0 ? "\x1b[?25l" : ""}\x1b[H${text}`]);
}

const dir = mkdtempSync(join(tmpdir(), "pi-monitor-dock-"));
const cast = join(dir, "dock.cast");
const header = { version: 2, width: COLS, height: ROWS, env: { TERM: "xterm-256color" } };
writeFileSync(cast, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");

mkdirSync(dirname(output), { recursive: true });

// Custom agg theme: background, foreground, then the 16 ANSI colours (unused, the dock writes 24-bit colour).
const ansi16 = Array.from({ length: 16 }, () => hex(look.muted));
const agg = spawnSync(
	process.env.AGG ?? "agg",
	[
		"--theme",
		[hex(BACKGROUND), hex(look.text), ...ansi16].join(","),
		"--text-font-family",
		FONTS,
		"--font-size",
		"28",
		"--line-height",
		"1.3",
		"--fps-cap",
		String(FPS),
		"--last-frame-duration",
		String(1 / FPS),
		cast,
		output,
	],
	{ encoding: "utf8" },
);
if (agg.error || agg.status !== 0) {
	console.error(agg.error?.message ?? agg.stderr.split("\r").at(-1));
	console.error(`agg failed. The cast is at ${cast}`);
	process.exit(1);
}
console.log(`${output} (${events.length} frames, ${LOOP_MS / 1000} s)`);
