import { formatShortDuration } from "../format.ts";
import { displayName, finishedText, hasFailure, isVisible, PROBATION_GLYPH, type DockItem } from "../ui/dock.ts";
import { jobCounts } from "../ui/glyphs.ts";

/** Pane token for the agent row: the most important monitor. */
export const PANE_TOKEN = "mon";
/** Herdr cuts token values at 80 characters. */
export const MAX_TOKEN_CHARS = 80;

/**
 * First character of every token. Herdr config rules colour a token by `starts_with`,
 * so each state starts with its own glyph.
 */
export const GLYPHS = {
	running: "◐",
	probation: PROBATION_GLYPH,
	paused: "‖",
	failure: "✗",
	timeout: "◔",
	success: "✓",
	stopped: "■",
	ended: "◌",
} as const;

const isGitHub = (item: DockItem) => item.kind === "gh_run" || item.kind === "gh_pr";

/**
 * Failures first, then running GitHub runs, then the finish moment of a success,
 * then other running monitors, then stopped ones.
 */
function rank(item: DockItem): number {
	if (hasFailure(item)) return 0;
	if (item.status === "running") return isGitHub(item) ? 1 : 3;
	return item.status === "success" ? 2 : 4;
}

/** Most important first. Ties: running ones oldest first, finished ones newest first. */
export function bySidebarImportance(items: readonly DockItem[]): DockItem[] {
	return [...items].sort(
		(a, b) =>
			rank(a) - rank(b) || (a.status === "running" ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0)),
	);
}

/** Whole minutes only, so the token changes at most once a minute while nothing else happens. */
function elapsed(ms: number): string {
	return ms < 60_000 ? "" : ` · ${formatShortDuration(ms)}`;
}

/** Cells of the ETA bar in the token. */
export const BAR_CELLS = 5;

/**
 * Text ETA bar, `▰▰▰▱▱`, from the dock's ETA estimate (median of recent green runs). Cells fill as whole
 * cells only, so the token changes a few times per run. The last cell waits for the end: a running run is
 * never shown as full. `▰▱` have a neutral East Asian width, so terminals draw them one column wide.
 */
export function etaCells(elapsedMs: number, etaMs: number, cells = BAR_CELLS): string {
	const filled = Math.max(0, Math.min(cells - 1, Math.floor((elapsedMs / etaMs) * cells)));
	return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/** `glyph name rest`, with the name cut so the whole line fits in `max` characters. The glyph stays first. */
function fitName(glyph: string, name: string, rest: string, max: number): string {
	const room = max - Array.from(`${glyph} ${rest}`).length;
	return `${glyph} ${capChars(name, Math.max(1, room))}${rest}`;
}

/**
 * One monitor as sidebar text, without colour: `◐ CI #42 ▰▰▰▱▱ 3/5 · 4m`, `✗ CI #42 test failed`,
 * `✓ CI #42 green in 6m02s`. At most `max` characters; a long name is cut before the bar and counts are.
 */
export function itemToken(item: DockItem, now: number, max = MAX_TOKEN_CHARS): string {
	if (item.status !== "running") return capChars(`${GLYPHS[item.status]} ${finishedText(item)}`, max);
	const name = displayName(item);
	if (item.probationUntil !== undefined) return fitName(GLYPHS.probation, name, "", max);
	if (item.paused) return fitName(GLYPHS.paused, name, " paused", max);
	const jobs = item.progress.jobs ?? [];
	const failed = jobs.find((j) => j.state === "failure");
	if (failed) return capChars(`${GLYPHS.failure} ${name} ${failed.name} failed`, max);
	const ms = now - (item.progress.startedAt ?? item.startedAt);
	const eta = isGitHub(item) && item.progress.etaMs ? ` ${etaCells(ms, item.progress.etaMs)}` : "";
	const counts = jobs.length ? ` ${jobCounts(jobs).done}/${jobs.length}` : "";
	return fitName(GLYPHS.running, name, `${eta}${counts}${elapsed(ms)}`, max);
}

/** Cut to `max` characters with `…`, counting code points like Herdr does. */
export function capChars(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The `$mon` value: the most important monitor plus ` +2` for other running ones. Null when nothing shows. */
export function paneToken(items: readonly DockItem[], now: number): string | null {
	const visible = bySidebarImportance(items.filter((i) => isVisible(i, now)));
	const top = visible[0];
	if (!top) return null;
	const others = visible.filter((i) => i !== top && i.status === "running").length;
	const more = others ? ` +${others}` : "";
	return itemToken(top, now, MAX_TOKEN_CHARS - more.length) + more;
}
