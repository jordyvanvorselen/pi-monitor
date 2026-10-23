// Record the README animation of the dock: renders the real dock v2 for every frame of the scripted story
// (scripts/dock-story.ts) with Pi's dark theme, turns each frame into an image with agg and joins them into
// docs/dock.gif with ffmpeg.
//
//   brew install agg ffmpeg        (agg also: cargo install --git https://github.com/asciinema/agg)
//   npm run record:dock
//
// Set AGG to use another agg binary. Intermediate files go to the OS temp directory.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRichDock } from "../src/ui/dock-rich.ts";
import type { Rgb } from "../src/ui/color.ts";
import { lookFor } from "../src/ui/look.ts";
import { LOOP_MS, story } from "./dock-story.ts";
import { piTheme } from "./pi-theme.ts";

const COLS = 112;
const ROWS = 7;
/** 12 frames a second matches the spinner and keeps the GIF around 2 MB. */
const FPS = Number(process.env.FPS ?? 12);
const FONT_SIZE = process.env.FONT_SIZE ?? "24";
/** 128 colours keep glows smooth. 64 shows bands in the red and green glows. */
const COLORS = process.env.COLORS ?? "128";
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

const dir = mkdtempSync(join(tmpdir(), "pi-monitor-dock-"));
mkdirSync(dirname(output), { recursive: true });

// Custom agg theme: background, foreground, then the 16 ANSI colours (unused, the dock writes 24-bit colour).
const aggTheme = [hex(BACKGROUND), hex(look.text), ...Array.from({ length: 16 }, () => hex(look.muted))].join(",");

/**
 * agg renders each frame on its own. Rendering the whole cast in one go lets gifski's temporal denoiser keep
 * faint traces of old text behind rows that changed. ffmpeg then joins the frames losslessly.
 */
async function renderFrame(index: number): Promise<void> {
	const name = join(dir, `frame-${String(index).padStart(4, "0")}`);
	const header = { version: 2, width: COLS, height: ROWS, env: { TERM: "xterm-256color" } };
	writeFileSync(`${name}.cast`, `${JSON.stringify(header)}\n${JSON.stringify([0, "o", frames[index]])}\n`);
	const args = ["--theme", aggTheme, "--text-font-family", FONTS, "--font-size", FONT_SIZE, "--line-height", "1.25"];
	await run(process.env.AGG ?? "agg", [...args, "--last-frame-duration", "1", `${name}.cast`, `${name}.gif`]);
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => reject(new Error(`${command}: ${error.message}`)));
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.split("\r").at(-1)}`)),
		);
	});
}

let next = 0;
const workers = Array.from({ length: Math.max(1, availableParallelism() - 1) }, async () => {
	while (next < frames.length) await renderFrame(next++);
});
try {
	await Promise.all(workers);
	// One palette for the whole loop, no dithering: crisp text and stable colours from frame to frame.
	const filter = `split[a][b];[a]palettegen=stats_mode=full:max_colors=${COLORS}[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
	await run("ffmpeg", [
		"-v",
		"error",
		"-y",
		"-f",
		"image2",
		"-c:v",
		"gif",
		"-framerate",
		String(FPS),
		"-i",
		join(dir, "frame-%04d.gif"),
		"-filter_complex",
		filter,
		"-loop",
		"0",
		output,
	]);
} catch (error) {
	console.error((error as Error).message);
	console.error(`The frames are in ${dir}`);
	process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log(`${output} (${frames.length} frames, ${LOOP_MS / 1000} s)`);
