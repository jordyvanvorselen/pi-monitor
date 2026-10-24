// Record the README animation of the dock: renders the real dock v2 for every frame of the scripted story
// (scripts/dock-story.ts) with Pi's dark theme and turns the frames into docs/dock.gif (scripts/gif.ts).
//
//   brew install agg ffmpeg        (agg also: cargo install --git https://github.com/asciinema/agg)
//   npm run record:dock
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRichDock } from "../src/ui/dock-rich.ts";
import type { Rgb } from "../src/ui/color.ts";
import { lookFor } from "../src/ui/look.ts";
import { LOOP_MS, story } from "./dock-story.ts";
import { writeGif } from "./gif.ts";
import { piTheme } from "./pi-theme.ts";

const COLS = 112;
const ROWS = 7;
/** 12 frames a second matches the spinner and keeps the GIF around 2 MB. */
const FPS = Number(process.env.FPS ?? 12);
const FONT_SIZE = Number(process.env.FONT_SIZE ?? 24);
/** 128 colours keep glows smooth. 64 shows bands in the red and green glows. */
const COLORS = Number(process.env.COLORS ?? 128);
/** Terminal background of the recording: a dark blue-grey that suits Pi's dark theme. */
const BACKGROUND: Rgb = [16, 18, 24];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ?? join(root, "docs", "dock.gif");

const theme = piTheme("dark");
const look = lookFor(theme, { background: BACKGROUND });
if (!look) throw new Error("Pi's dark theme gave no colour look");

const width = COLS - 2;
const frames: string[] = [];
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
	frames.push(`\x1b[?25l\x1b[H${text}`);
}

try {
	await writeGif({
		frames,
		cols: COLS,
		rows: ROWS,
		fps: FPS,
		background: BACKGROUND,
		foreground: look.text,
		output,
		colors: COLORS,
		fontSize: FONT_SIZE,
	});
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
console.log(`${output} (${frames.length} frames, ${LOOP_MS / 1000} s)`);
