import { formatShortDuration } from "../format.ts";
import type { ActivityBucket } from "../registry.ts";
import { ACTIVITY_BUCKET_MS } from "../registry.ts";
import type { Job } from "../sources/types.ts";

/** Theme colors this extension uses. Pi's `Theme` fits this shape. */
export type Color =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "border"
	| "borderMuted"
	| "borderAccent"
	| "toolOutput";

export interface Paint {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(frame: number, reducedMotion: boolean): string {
	return reducedMotion ? "◉" : SPINNER[frame % SPINNER.length]!;
}

const JOB_GLYPH: Record<Job["state"], [string, Color]> = {
	success: ["●", "success"],
	failure: ["✗", "error"],
	running: ["◐", "accent"],
	queued: ["○", "dim"],
	skipped: ["◌", "dim"],
};

export function jobCounts(jobs: readonly Job[]): { done: number; total: number; failed: number } {
	const done = jobs.filter((j) => j.state === "success" || j.state === "failure" || j.state === "skipped").length;
	return { done, total: jobs.length, failed: jobs.filter((j) => j.state === "failure").length };
}

/**
 * Job track: `●━━●━━◐┄┄○`. Solid links after finished jobs, dotted links after the rest.
 * Long tracks use one-character links; very long ones fall back to `12/19`.
 */
export function jobTrack(jobs: readonly Job[], paint: Paint, maxWidth = 40): string {
	if (jobs.length === 0) return "";
	for (const linkWidth of [2, 1]) {
		if (jobs.length + (jobs.length - 1) * linkWidth > maxWidth) continue;
		return jobs
			.map((job, i) => {
				const [glyph, color] = JOB_GLYPH[job.state];
				const node = paint.fg(color, glyph);
				if (i === jobs.length - 1) return node;
				const finished = job.state !== "running" && job.state !== "queued";
				return node + paint.fg(finished ? "muted" : "dim", (finished ? "━" : "┄").repeat(linkWidth));
			})
			.join("");
	}
	const { done, total, failed } = jobCounts(jobs);
	return paint.fg(failed ? "error" : "muted", `${done}/${total}`);
}

/** ETA bar from the typical duration: `▰▰▰▱▱ ~3m`, or `▰▰▰▰▰ +1m` when it runs late. */
export function etaBar(elapsedMs: number, etaMs: number, paint: Paint, cells = 5): string {
	const ratio = Math.max(0, elapsedMs / etaMs);
	const filled = Math.min(cells, Math.round(ratio * cells));
	const bar = paint.fg("accent", "▰".repeat(filled)) + paint.fg("dim", "▱".repeat(cells - filled));
	const left = etaMs - elapsedMs;
	const label =
		left >= 0
			? paint.fg("muted", `~${formatShortDuration(left)}`)
			: paint.fg("warning", `+${formatShortDuration(-left)}`);
	return `${bar} ${label}`;
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Activity sparkline: lines per 10 s bucket, newest on the right. */
export function sparkline(activity: readonly ActivityBucket[], now: number, paint: Paint, cells = 8): string {
	const newest = Math.floor(now / ACTIVITY_BUCKET_MS);
	const counts: number[] = [];
	for (let b = newest - cells + 1; b <= newest; b++) counts.push(activity.find((a) => a.bucket === b)?.count ?? 0);
	const max = Math.max(...counts);
	return counts
		.map((count) => {
			if (count === 0 || max === 0) return paint.fg("dim", SPARK[0]!);
			const level = Math.max(1, Math.round((count / max) * (SPARK.length - 1)));
			return paint.fg("accent", SPARK[level]!);
		})
		.join("");
}
