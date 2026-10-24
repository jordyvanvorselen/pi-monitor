// Turn terminal frames (ANSI text) into a GIF: agg renders every frame on its own, ffmpeg joins them with one
// palette. Shared by the README recordings.
//
//   brew install agg ffmpeg        (agg also: cargo install --git https://github.com/asciinema/agg)
//
// Set AGG to use another agg binary. Intermediate files go to the OS temp directory.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Rgb } from "../src/ui/color.ts";

/** Hack and DejaVu draw braille with big dots, close to what terminals like Ghostty and kitty draw themselves. */
const FONTS = "Hack Nerd Font Mono,Hack,DejaVu Sans Mono,JetBrains Mono,Fira Code,Menlo";

export interface GifOptions {
	/** One full screen per frame, as ANSI text. */
	frames: readonly string[];
	cols: number;
	rows: number;
	fps: number;
	background: Rgb;
	foreground: Rgb;
	output: string;
	/** Palette size. 128 keeps glows smooth; 64 shows bands in the red and green glows. */
	colors?: number;
	fontSize?: number;
	/** Cut agg's margin, so the frame fills the GIF edge to edge (for frames that paint their own background). */
	trim?: boolean;
	/**
	 * Per frame, one key per cell (row by row) that changes when the cell's look changes. agg quantises every
	 * frame with its own palette, so text that did not change still flickers a little from frame to frame. With
	 * keys, cells that stayed the same (and their neighbours) keep the previous frame's pixels exactly: no
	 * flicker, and a much smaller GIF.
	 */
	cellKeys?: readonly (readonly string[])[];
}

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

const hex = (c: readonly number[]) => c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

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

export async function writeGif(options: GifOptions): Promise<void> {
	const { frames, cols, rows, fps, output } = options;
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-gif-"));
	mkdirSync(dirname(output), { recursive: true });
	// Custom agg theme: background, foreground, then the 16 ANSI colours (unused, the frames write 24-bit colour).
	const theme = [hex(options.background), hex(options.foreground), ...Array(16).fill(hex(options.foreground))].join(
		",",
	);
	const fontSize = String(options.fontSize ?? 24);

	/**
	 * agg renders each frame on its own. Rendering the whole cast in one go lets gifski's temporal denoiser keep
	 * faint traces of old text behind rows that changed. ffmpeg then joins the frames losslessly.
	 */
	async function renderFrame(index: number): Promise<void> {
		const name = join(dir, `frame-${String(index).padStart(4, "0")}`);
		const header = { version: 2, width: cols, height: rows, env: { TERM: "xterm-256color" } };
		writeFileSync(`${name}.cast`, `${JSON.stringify(header)}\n${JSON.stringify([0, "o", frames[index]])}\n`);
		const args = ["--theme", theme, "--text-font-family", FONTS, "--font-size", fontSize, "--line-height", "1.25"];
		await run(process.env.AGG ?? "agg", [...args, "--last-frame-duration", "1", `${name}.cast`, `${name}.gif`]);
	}

	/** Where agg puts the terminal inside its margin: render a white screen and find its edges. */
	async function contentBox(): Promise<Box> {
		const name = join(dir, "probe");
		const white = `\x1b[48;2;255;255;255m${" ".repeat(cols)}`;
		const screen = `\x1b[H${Array(rows).fill(white).join("\r\n")}`;
		writeFileSync(
			`${name}.cast`,
			`${JSON.stringify({ version: 2, width: cols, height: rows })}\n${JSON.stringify([0, "o", screen])}\n`,
		);
		const args = ["--theme", theme, "--text-font-family", FONTS, "--font-size", fontSize, "--line-height", "1.25"];
		await run(process.env.AGG ?? "agg", [...args, "--last-frame-duration", "1", `${name}.cast`, `${name}.gif`]);
		const size = execFileSync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"stream=width,height",
			"-of",
			"csv=p=0",
			`${name}.gif`,
		]);
		const [w, h] = size.toString().trim().split(",").map(Number) as [number, number];
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-y",
			"-i",
			`${name}.gif`,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"gray",
			`${name}.raw`,
		]);
		const px = readFileSync(`${name}.raw`);
		const bright = (i: number) => px[i]! > 128;
		const mid = Math.floor(h / 2) * w;
		const left = Array.from({ length: w }, (_, x) => x).find((x) => bright(mid + x))!;
		const right = Array.from({ length: w }, (_, x) => w - 1 - x).find((x) => bright(mid + x))!;
		const column = Math.floor(w / 2);
		const top = Array.from({ length: h }, (_, y) => y).find((y) => bright(y * w + column))!;
		const bottom = Array.from({ length: h }, (_, y) => h - 1 - y).find((y) => bright(y * w + column))!;
		return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
	}

	/** Decode the frames, keep unchanged cells from the previous frame, then encode the GIF. */
	async function stabilized(
		input: string[],
		crop: string,
		palette: string,
		box: Box,
		keys: readonly (readonly string[])[],
	): Promise<void> {
		const size = box.w * box.h * 3;
		const decode = spawn("ffmpeg", [
			"-v",
			"error",
			...input,
			"-vf",
			crop.slice(0, -1),
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"-",
		]);
		const encode = spawn(
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				...["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${box.w}x${box.h}`, "-framerate", String(fps), "-i", "-"],
				...["-filter_complex", palette, "-loop", "0", output],
			],
			{ stdio: ["pipe", "ignore", "inherit"] },
		);
		const done = new Promise<void>((resolve, reject) =>
			encode.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))),
		);
		const cellW = box.w / cols;
		const cellH = box.h / rows;
		let previous: Buffer | undefined;
		let index = 0;
		let pending = Buffer.alloc(0);
		for await (const chunk of decode.stdout as AsyncIterable<Buffer>) {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= size) {
				const frame = Buffer.from(pending.subarray(0, size));
				pending = pending.subarray(size);
				const now = keys[index]!;
				const before = keys[index - 1];
				if (previous && before) {
					// A cell may draw into its neighbours (wide glyphs, glows): changed cells keep a one-cell border.
					const changed = new Uint8Array(cols * rows);
					for (let i = 0; i < now.length; i++)
						if (now[i] !== before[i]) {
							const cx = i % cols;
							const cy = Math.floor(i / cols);
							for (let dy = -1; dy <= 1; dy++)
								for (let dx = -1; dx <= 1; dx++) {
									const x = cx + dx;
									const y = cy + dy;
									if (x >= 0 && x < cols && y >= 0 && y < rows) changed[y * cols + x] = 1;
								}
						}
					for (let py = 0; py < box.h; py++) {
						const cy = Math.min(rows - 1, Math.floor(py / cellH));
						for (let px = 0; px < box.w; px++) {
							if (changed[cy * cols + Math.min(cols - 1, Math.floor(px / cellW))]) continue;
							const o = (py * box.w + px) * 3;
							frame[o] = previous[o]!;
							frame[o + 1] = previous[o + 1]!;
							frame[o + 2] = previous[o + 2]!;
						}
					}
				}
				previous = frame;
				index++;
				if (!encode.stdin.write(frame)) await new Promise((resolve) => encode.stdin.once("drain", resolve));
			}
		}
		encode.stdin.end();
		await done;
	}

	let next = 0;
	const workers = Array.from({ length: Math.max(1, availableParallelism() - 1) }, async () => {
		while (next < frames.length) await renderFrame(next++);
	});
	try {
		await Promise.all(workers);
		const box = options.trim ? await contentBox() : undefined;
		const crop = box ? `crop=${box.w}:${box.h}:${box.x}:${box.y},` : "";
		// One palette for the whole loop, no dithering: crisp text and stable colours from frame to frame.
		const palette = `split[a][b];[a]palettegen=stats_mode=full:max_colors=${options.colors ?? 128}[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
		const input = ["-f", "image2", "-c:v", "gif", "-framerate", String(fps), "-i", join(dir, "frame-%04d.gif")];
		if (options.cellKeys && box) await stabilized(input, crop, palette, box, options.cellKeys);
		else
			await run("ffmpeg", [
				"-v",
				"error",
				"-y",
				...input,
				"-filter_complex",
				`${crop}${palette}`,
				"-loop",
				"0",
				output,
			]);
	} catch (error) {
		throw new Error(`${(error as Error).message}\nThe frames are in ${dir}`, { cause: error });
	}
	rmSync(dir, { recursive: true, force: true });
}
