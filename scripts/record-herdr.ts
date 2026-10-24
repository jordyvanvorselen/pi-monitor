// Record the README animation of the Herdr sidebar: pi-monitor's real Herdr code (sidebar tokens, toasts,
// blocked marks) runs the scripted story on a virtual clock (scripts/herdr-story.ts), every frame is drawn as
// Herdr's window with the real dock v2 in the pi pane (scripts/herdr-view.ts), and scripts/gif.ts turns the
// frames into docs/herdr.gif.
//
//   brew install agg ffmpeg        (agg also: cargo install --git https://github.com/asciinema/agg)
//   npm run record:herdr
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paletteFor } from "../src/herdr/integration.ts";
import { writeGif } from "./gif.ts";
import { LOOP_MS, sceneAt, simulate } from "./herdr-story.ts";
import { COLS, GRADIENT, renderHerdr, ROWS } from "./herdr-view.ts";
import { piTheme } from "./pi-theme.ts";

/** 12 frames a second, like the dock recording. */
const FPS = Number(process.env.FPS ?? 12);
/** 256 colours: the window gradient takes palette entries, and 128 shows dark blocks in fading glows. */
const COLORS = Number(process.env.COLORS ?? 256);
const FONT_SIZE = Number(process.env.FONT_SIZE ?? 24);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ?? join(root, "docs", "herdr.gif");

const theme = piTheme("dark");
// The colours `/monitors herdr` writes into Herdr's config for pi's dark theme.
const palette = paletteFor(theme);
const timeline = await simulate();

const frames: string[] = [];
const cellKeys: string[][] = [];
for (let frame = 0; frame < (LOOP_MS / 1000) * FPS; frame++) {
	const { lines, keys } = renderHerdr(sceneAt(timeline, (frame * 1000) / FPS), { theme, palette });
	frames.push(`\x1b[?25l\x1b[H${lines.join("\r\n")}`);
	cellKeys.push(keys);
}

try {
	await writeGif({
		frames,
		cols: COLS,
		rows: ROWS,
		fps: FPS,
		background: GRADIENT[1],
		foreground: [255, 255, 255],
		output,
		colors: COLORS,
		fontSize: FONT_SIZE,
		trim: true,
		cellKeys,
	});
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
console.log(`${output} (${frames.length} frames, ${LOOP_MS / 1000} s)`);
