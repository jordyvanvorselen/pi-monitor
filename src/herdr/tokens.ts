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

/** The `$mon` value: the most important monitor. Null when nothing shows. */
export function paneToken(items: readonly DockItem[], now: number): string | null {
	const visible = bySidebarImportance(items.filter((i) => isVisible(i, now)));
	const top = visible[0];
	return top ? itemToken(top, now) : null;
}

/** Count tokens for the row under `$mon`, one per state, so the config can colour each one. */
export const COUNT_TOKENS = {
	failure: "mon_fail",
	running: "mon_run",
	waiting: "mon_wait",
	success: "mon_ok",
} as const;

type CountState = keyof typeof COUNT_TOKENS;

/** The glyph each count starts with: the same glyphs as `$mon`. */
const COUNT_GLYPHS: Record<CountState, string> = {
	failure: GLYPHS.failure,
	running: GLYPHS.running,
	waiting: GLYPHS.probation,
	success: GLYPHS.success,
};

/** A GitHub run whose jobs all wait for a runner, as the dock shows it. */
function queued(item: DockItem): boolean {
	const jobs = item.progress.jobs ?? [];
	return isGitHub(item) && !jobs.some((j) => j.state === "running") && jobs.some((j) => j.state === "queued");
}

function countState(item: DockItem): CountState | undefined {
	if (hasFailure(item)) return "failure";
	if (item.status === "running") return item.probationUntil !== undefined || queued(item) ? "waiting" : "running";
	return item.status === "success" ? "success" : undefined;
}

/**
 * Values for the count tokens: `✗1`, `◐2`, `⏳1`, `✓1`. Failures include timeouts and running runs with a
 * failed job; waiting means a command on probation or a run waiting for a runner; success counts finish
 * moments still on screen. Stopped and ended monitors are not counted. Zero is null, and with fewer than
 * two visible monitors everything is null, so the row only shows when `$mon` does not tell the whole story.
 */
export function countTokens(items: readonly DockItem[], now: number): Record<string, string | null> {
	const visible = items.filter((i) => isVisible(i, now));
	const counts: Record<CountState, number> = { failure: 0, running: 0, waiting: 0, success: 0 };
	if (visible.length >= 2)
		for (const item of visible) {
			const state = countState(item);
			if (state) counts[state]++;
		}
	return Object.fromEntries(
		(Object.keys(COUNT_TOKENS) as CountState[]).map((state) => [
			COUNT_TOKENS[state],
			counts[state] ? `${COUNT_GLYPHS[state]}${counts[state]}` : null,
		]),
	);
}

/** Every token pi-monitor reports for the pane: `$mon` and the counts. */
export function sidebarTokens(items: readonly DockItem[], now: number): Record<string, string | null> {
	return { [PANE_TOKEN]: paneToken(items, now), ...countTokens(items, now) };
}
