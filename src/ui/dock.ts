import { hyperlink, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatDuration, formatShortDuration, formatTokens } from "../format.ts";
import type { ActivityBucket, MonitorStatus } from "../registry.ts";
import type { Progress, SourceKind } from "../sources/types.ts";
import { etaBar, jobCounts, jobTrack, type Paint, sparkline, spinner } from "./glyphs.ts";

/** The monitor fields the dock reads. `MonitorRecord` fits this shape. */
export interface DockItem {
	id: string;
	description: string;
	kind: SourceKind;
	status: MonitorStatus;
	paused: boolean;
	startedAt: number;
	endedAt?: number;
	summary?: string;
	progress: Progress;
	lastLine?: string;
	lastLineAt?: number;
	activity: ActivityBucket[];
	handling: boolean;
	/** Safety-net probation: moves to the background at this time unless it ends first. */
	probationUntil?: number;
}

export interface DockOptions {
	width: number;
	now: number;
	frame: number;
	savedTokens: number;
	shortcut: string;
	reducedMotion: boolean;
}

/** A finished row flashes this long, then shows a one-line summary. */
export const FLASH_MS = 1_500;
/** A finished row disappears after this long. */
export const LINGER_MS = 10_000;
/** A command without output for this long is "quiet". */
export const STALE_MS = 5 * 60_000;
/** With more rows than this the card shows the most important ones plus "+N more". */
export const MAX_ROWS = 4;

const WIDE = 88;
const MEDIUM = 56;

export function isVisible(item: DockItem, now: number): boolean {
	return item.status === "running" || (item.endedAt !== undefined && now - item.endedAt < LINGER_MS);
}

export function hasFailure(item: DockItem): boolean {
	return (
		item.status === "failure" ||
		item.status === "timeout" ||
		(item.status === "running" && (item.progress.jobs ?? []).some((j) => j.state === "failure"))
	);
}

/** Failures first, then running monitors (oldest first), then the rest (newest first). */
export function byImportance(items: readonly DockItem[]): DockItem[] {
	const rank = (item: DockItem) => (hasFailure(item) ? 0 : item.status === "running" ? 1 : 2);
	return [...items].sort(
		(a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0)),
	);
}

export function displayName(item: DockItem): string {
	return item.progress.title ?? item.description;
}

function linkedName(item: DockItem, paint: Paint): string {
	const name = paint.fg("text", displayName(item));
	return item.progress.url ? hyperlink(name, item.progress.url) : name;
}

/** Put `right` at the right edge and truncate `left` so the line is exactly `width` wide. */
export function fit(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (!right || rightWidth + 4 > width) return truncateToWidth(left, width, "…", true);
	const head = truncateToWidth(left, width - rightWidth - 2, "…");
	return head + " ".repeat(width - visibleWidth(head) - rightWidth) + right;
}

const END_GLYPH: Record<Exclude<MonitorStatus, "running">, [string, "success" | "error" | "warning" | "dim"]> = {
	success: ["✓", "success"],
	failure: ["✗", "error"],
	timeout: ["◔", "warning"],
	stopped: ["■", "dim"],
	ended: ["◌", "dim"],
};

function finishedText(item: DockItem): string {
	const name = displayName(item);
	const summary = item.status === "ended" ? "ended with the session" : (item.summary ?? item.status);
	return summary.startsWith(name) ? summary : `${name} ${summary}`;
}

function finishedRow(item: DockItem, width: number, options: DockOptions, paint: Paint): string {
	const status = item.status as Exclude<MonitorStatus, "running">;
	const [glyph, color] = END_GLYPH[status];
	const text = finishedText(item);
	const right = item.handling ? paint.fg("accent", "pi is on it ↳") : "";
	const flashing = !options.reducedMotion && item.endedAt !== undefined && options.now - item.endedAt < FLASH_MS;
	if (flashing && (status === "success" || status === "failure"))
		return fit(paint.bold(paint.fg(color, `${glyph} ${text}`)), right, width);
	return fit(`${paint.fg(color, glyph)} ${paint.fg("muted", text)}`, right, width);
}

/** Glyph of a bash command the safety net may still hand back. */
export const PROBATION_GLYPH = "⏳";

function runningGlyph(item: DockItem, options: DockOptions, paint: Paint): string {
	if (item.probationUntil !== undefined) return PROBATION_GLYPH;
	if (item.paused) return paint.fg("warning", "‖");
	return paint.fg(hasFailure(item) ? "error" : "accent", spinner(options.frame, options.reducedMotion));
}

function age(ms: number, paint: Paint): string {
	if (ms >= STALE_MS) return paint.fg("warning", `quiet ${formatShortDuration(ms)}`);
	return paint.fg(ms < 60_000 ? "muted" : "dim", `${formatShortDuration(ms)} ago`);
}

const WAITING: Record<SourceKind, string> = {
	command: "waiting for output",
	file: "waiting for new lines",
	url: "waiting for 2xx",
	pid: "waiting for exit",
	gh_run: "starting…",
	gh_pr: "starting…",
};

function ghDetail(item: DockItem, paint: Paint): string {
	if (item.paused) return paint.fg("warning", "paused (too noisy)");
	const jobs = item.progress.jobs ?? [];
	const running = jobs.filter((j) => j.state === "running");
	const current = running[0];
	if (current) {
		const more = running.length > 1 ? paint.fg("dim", ` +${running.length - 1}`) : "";
		const step = current.step ? paint.fg("dim", " ▸ ") + paint.fg("muted", current.step) : "";
		return paint.fg("text", current.name) + step + more;
	}
	if (jobs.some((j) => j.state === "queued")) return paint.fg("dim", "waiting for a runner");
	return paint.fg("dim", WAITING[item.kind]);
}

function runningRow(item: DockItem, width: number, options: DockOptions, paint: Paint): string {
	const { now } = options;
	const glyph = runningGlyph(item, options, paint);
	const name = linkedName(item, paint);
	const startedAt = item.progress.startedAt ?? item.startedAt;
	const elapsed = now - startedAt;
	const jobs = item.progress.jobs;
	const isGh = item.kind === "gh_run" || item.kind === "gh_pr";
	const stale = item.lastLineAt !== undefined && now - item.lastLineAt >= STALE_MS;
	const countdown =
		item.probationUntil !== undefined
			? formatShortDuration(Math.max(0, Math.ceil((item.probationUntil - now) / 1000) * 1000))
			: undefined;

	if (width < MEDIUM) {
		const parts = [glyph, name];
		if (isGh && jobs?.length) {
			const { done, total, failed } = jobCounts(jobs);
			parts.push(paint.fg(failed ? "error" : "muted", `${done}/${total}`));
		}
		parts.push(countdown ? paint.fg("dim", `bg in ${countdown}`) : paint.fg("muted", formatShortDuration(elapsed)));
		if (!isGh && stale) parts.push(age(now - item.lastLineAt!, paint));
		if (item.handling) parts.push(paint.fg("accent", "↳"));
		return truncateToWidth(parts.join(" "), width, "…", true);
	}

	const wide = width >= WIDE;
	const right: string[] = [];
	if (item.handling) right.push(paint.fg("accent", "pi is on it ↳"));
	if (wide && isGh && item.progress.etaMs) right.push(etaBar(elapsed, item.progress.etaMs, paint));
	right.push(countdown ? paint.fg("dim", `background in ${countdown}`) : paint.fg("muted", formatDuration(elapsed)));
	const rightText = right.join("  ");

	if (isGh) {
		const left = [`${glyph} ${name}`];
		if (jobs?.length) left.push(jobTrack(jobs, paint, wide ? 30 : 16));
		left.push(ghDetail(item, paint));
		return fit(left.join("  "), rightText, width);
	}

	const head = [`${glyph} ${name}`];
	if (wide) head.push(sparkline(item.activity, now, paint));
	if (item.paused) return fit([...head, paint.fg("warning", "paused (too noisy)")].join("  "), rightText, width);
	if (item.lastLine === undefined || item.lastLineAt === undefined)
		return fit([...head, paint.fg("dim", WAITING[item.kind])].join("  "), rightText, width);
	const prefix = [...head, paint.fg("dim", "last: ")].join("  ");
	const suffix = paint.fg("dim", " · ") + age(now - item.lastLineAt, paint);
	const room = width - visibleWidth(prefix) - visibleWidth(suffix) - visibleWidth(rightText) - 2;
	const line = truncateToWidth(item.lastLine.replace(/\s+/g, " ").trim(), Math.max(6, room), "…");
	return fit(prefix + paint.fg("toolOutput", line) + suffix, rightText, width);
}

export function renderRow(item: DockItem, width: number, options: DockOptions, paint: Paint): string {
	return item.status === "running" ? runningRow(item, width, options, paint) : finishedRow(item, width, options, paint);
}

function shortToken(item: DockItem, paint: Paint): string {
	const name = displayName(item);
	const handling = item.handling ? paint.fg("accent", " ↳") : "";
	if (item.status !== "running") {
		const [glyph, color] = END_GLYPH[item.status];
		return `${paint.fg("muted", name)} ${paint.fg(color, glyph)}${handling}`;
	}
	const jobs = item.progress.jobs;
	if (jobs?.length) {
		const { done, total, failed } = jobCounts(jobs);
		return `${paint.fg("text", name)} ${paint.fg(failed ? "error" : "muted", `${done}/${total}`)}${handling}`;
	}
	if (item.paused) return `${paint.fg("text", name)} ${paint.fg("warning", "‖")}${handling}`;
	return `${paint.fg("text", name)}${handling}`;
}

/** One line: `◉ 3 monitors · CI 3/5 · e2e ✗`. */
export function renderLine(items: readonly DockItem[], options: DockOptions, paint: Paint): string {
	const running = items.some((i) => i.status === "running");
	const dot = paint.fg(running ? "accent" : "muted", "◉");
	const count = paint.fg("muted", `${items.length} monitor${items.length === 1 ? "" : "s"}`);
	const sep = paint.fg("dim", " · ");
	const tokens = items.map((item) => shortToken(item, paint));
	return truncateToWidth([`${dot} ${count}`, ...tokens].join(sep), options.width, "…");
}

function summaryText(items: readonly DockItem[], saved: number, paint: Paint): string {
	const running = items.filter((i) => i.status === "running").length;
	const failed = items.filter(hasFailure).length;
	const parts: string[] = [];
	if (running) parts.push(paint.fg("muted", `${running} running`));
	if (failed) parts.push(paint.fg("error", `${failed} failed`));
	if (saved >= 100) parts.push(paint.fg("muted", `saved ~${formatTokens(saved)} tok`));
	return parts.join(paint.fg("dim", " · "));
}

/** `╭─ title ──────── right ─╮`. Drops `right` when it does not fit. */
function border(title: string, right: string, width: number, edges: [string, string], paint: Paint): string {
	const [open, close] = edges;
	const titlePart = title ? ` ${title} ` : "";
	let rightPart = right ? ` ${right} ` : "";
	if (4 + visibleWidth(titlePart) + visibleWidth(rightPart) > width) rightPart = "";
	const fill = Math.max(0, width - 4 - visibleWidth(titlePart) - visibleWidth(rightPart));
	const line =
		paint.fg("border", `${open}─`) +
		titlePart +
		paint.fg("border", "─".repeat(fill)) +
		rightPart +
		paint.fg("border", `─${close}`);
	return truncateToWidth(line, width);
}

/**
 * Render the dock. Card: rounded border, title and summary on top, one row per monitor, a hint below.
 * Returns no lines when nothing is visible, so the widget can be removed.
 */
export function renderDock(all: readonly DockItem[], options: DockOptions, paint: Paint): string[] {
	const items = byImportance(all.filter((i) => isVisible(i, options.now)));
	if (items.length === 0) return [];
	const { width } = options;
	// Too narrow for a card: one line. The dock never folds otherwise.
	if (width < 24) return [renderLine(items, options, paint)];

	const inner = width - 4;
	const shown = items.length > MAX_ROWS ? items.slice(0, MAX_ROWS - 1) : items;
	const side = paint.fg("border", "│");
	const rows = shown.map((item) => `${side} ${renderRow(item, inner, options, paint)} ${side}`);
	if (shown.length < items.length) {
		const more = paint.fg("dim", `+${items.length - shown.length} more · /monitors`);
		rows.push(`${side} ${truncateToWidth(more, inner, "…", true)} ${side}`);
	}
	const top = border(
		paint.bold(paint.fg("accent", "monitors")),
		summaryText(items, options.savedTokens, paint),
		width,
		["╭", "╮"],
		paint,
	);
	const bottom = border("", paint.fg("dim", `${options.shortcut} view · /monitors`), width, ["╰", "╯"], paint);
	return [top, ...rows, bottom];
}

/** Widget component. Caches lines per width; `refresh()` drops the cache and asks for a render. */
export class DockComponent implements Component {
	private cache: { width: number; lines: string[] } | undefined;
	private readonly draw: (width: number) => string[];

	constructor(draw: (width: number) => string[]) {
		this.draw = draw;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines = this.draw(width);
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
