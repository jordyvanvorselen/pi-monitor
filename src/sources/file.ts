import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Source } from "./types.ts";

const POLL_MS = 500;
const MAX_CHUNK = 1024 * 1024;

/**
 * Tails a file like `tail -F`: only lines written after the start, survives truncation and
 * waits for the file to appear. Polls every 500 ms, which is cheap and works on every file system.
 */
export function fileSource(path: string): Source {
	return {
		kind: "file",
		label: `tail ${path}`,
		async start(ctx) {
			const full = resolve(ctx.cwd, path);
			let offset: number | undefined;
			let carry = "";
			try {
				offset = (await stat(full)).size;
			} catch {
				offset = 0;
			}
			while (!ctx.signal.aborted) {
				let size: number;
				try {
					size = (await stat(full)).size;
				} catch {
					await ctx.sleep(POLL_MS);
					continue;
				}
				if (size < offset) {
					offset = 0;
					carry = "";
				}
				if (size > offset) {
					const length = Math.min(size - offset, MAX_CHUNK);
					const handle = await open(full, "r");
					try {
						const buffer = Buffer.alloc(length);
						const { bytesRead } = await handle.read(buffer, 0, length, offset);
						offset += bytesRead;
						const parts = (carry + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
						carry = parts.pop() ?? "";
						for (const line of parts) ctx.line(line.replace(/\r$/, ""));
					} finally {
						await handle.close();
					}
					if (size > offset) continue;
				}
				await ctx.sleep(POLL_MS);
			}
			return { status: "stopped", summary: "stopped" };
		},
	};
}
