import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatShortDuration } from "../format.ts";
import { displayName, hasFailure, isVisible, PROBATION_GLYPH, type DockItem } from "../ui/dock.ts";
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

/** Herdr's sidebar is 26 columns by default. `$mon` aims at this many, so it fits next to the row's indent. */
export const TARGET_COLUMNS = 22;
/** A name is cut to this many columns before anything else goes. */
export const NAME_MIN = 8;
/** A detail such as a failed job name is cut to this many columns at least. */
const DETAIL_MIN = 4;

/**
 * One part of a token after the name. `drop`: may go when the line is too long, lowest first.
 * `cut`: may be cut short. Neither: always stays, like the ` ↳` marker.
 */
interface Part {
	text: string;
	drop?: number;
	cut?: boolean;
}

const segmenter = new Intl.Segmenter();

/** Cut `text` to `cols` terminal columns with `…`. Counts wide characters as two. */
export function cutColumns(text: string, cols: number): string {
	if (visibleWidth(text) <= cols) return text;
	if (cols < 1) return "";
	let out = "";
	let width = 0;
	for (const { segment } of segmenter.segment(text)) {
		const w = visibleWidth(segment);
		if (width + w > cols - 1) break;
		out += segment;
		width += w;
	}
	return `${out.trimEnd()}…`;
}

/**
 * `glyph name part part…`, aiming at `target` columns. The glyph always stays first. Order when it does not fit:
 * cut the name to `NAME_MIN` columns, drop the droppable parts (lowest `drop` first, giving the name its room
 * back), cut the detail part to `DETAIL_MIN`, then cut the name further. The hard cap is Herdr's 80 characters.
 */
export function compose(glyph: string, name: string, parts: readonly Part[], target = TARGET_COLUMNS): string {
	let kept = [...parts];
	const drops = parts.filter((p) => p.drop !== undefined).sort((a, b) => a.drop! - b.drop!);
	const line = (n: string, ps: readonly Part[]) => `${glyph} ${n}${ps.map((p) => ` ${p.text}`).join("")}`;
	const room = (ps: readonly Part[]) => target - visibleWidth(line("", ps));
	const nameMin = Math.min(NAME_MIN, visibleWidth(name));
	for (;;) {
		if (room(kept) >= nameMin) return capChars(line(cutColumns(name, room(kept)), kept), MAX_TOKEN_CHARS);
		const next = drops.shift();
		if (!next) break;
		kept = kept.filter((p) => p !== next);
	}
	const short = cutColumns(name, nameMin);
	const over = visibleWidth(line(short, kept)) - target;
	kept = kept.map((p) => (p.cut ? { text: cutColumns(p.text, Math.max(DETAIL_MIN, visibleWidth(p.text) - over)) } : p));
	const left = Math.max(1, room(kept));
	return capChars(line(cutColumns(name, Math.min(nameMin, left)), kept), MAX_TOKEN_CHARS);
}

/** How long a monitor ran, in the dock's format: `2m40s`. GitHub runs count from the run's own start. */
function took(item: DockItem): string {
	return formatDuration((item.endedAt ?? item.startedAt) - (item.progress.startedAt ?? item.startedAt));
}

const CONCLUSION = /\b(cancelled|timed_out|startup_failure|action_required)\b/;

/** The short reason of a failure: the failed job, the exit code or signal, else `failed`. */
function failureDetail(item: DockItem): string {
	const job = (item.progress.jobs ?? []).find((j) => j.state === "failure");
	if (job) return job.name;
	const summary = item.summary ?? "";
	const code = /exited with code (\d+)/.exec(summary);
	if (code) return `code ${code[1]}`;
	const signal = /killed by (\S+)/.exec(summary);
	if (signal) return signal[1]!;
	const conclusion = CONCLUSION.exec(summary);
	if (conclusion) return conclusion[1]!.replace("_", " ");
	if (summary.startsWith("could not start")) return "could not start";
	return "failed";
}

/** Failed jobs after the first: ` +2`. */
function moreFailed(item: DockItem): Part[] {
	const failed = (item.progress.jobs ?? []).filter((j) => j.state === "failure").length;
	return failed > 1 ? [{ text: `+${failed - 1}`, drop: 1 }] : [];
}

/** The end of a monitor, short: `✓ Deploy #88 2m40s`, `✗ e2e #17 checkout`, `✗ tests code 1`, `◔ build timed out`. */
function finishedParts(item: DockItem): Part[] {
	switch (item.status) {
		case "success":
			return [{ text: took(item), drop: 0 }];
		case "failure":
			return [{ text: failureDetail(item), cut: true }, ...moreFailed(item)];
		case "timeout":
			return [{ text: "timed out", cut: true }];
		case "stopped":
			return [{ text: "stopped", cut: true }];
		default:
			return [{ text: "ended", cut: true }];
	}
}

/** ` ↳` while the model handles a message from this monitor, like the dock's "pi is on it ↳". */
const HANDLING: Part = { text: "↳" };

/**
 * One monitor as sidebar text, without colour: `◐ CI #42 ▰▰▰▱▱ 3/5 4m`, `✗ CI #42 test ↳`, `✓ CI #42 6m02s`.
 * Aims at `target` columns (see `compose` for what goes first) and never passes Herdr's 80 characters.
 * Running rows drop the clock first, then the ETA bar, then the job counts.
 */
export function itemToken(item: DockItem, now: number, target = TARGET_COLUMNS): string {
	const name = displayName(item);
	const handling = item.handling ? [HANDLING] : [];
	if (item.status !== "running")
		return compose(GLYPHS[item.status], name, [...finishedParts(item), ...handling], target);
	if (item.probationUntil !== undefined) return compose(GLYPHS.probation, name, handling, target);
	if (item.paused) return compose(GLYPHS.paused, name, [{ text: "paused", cut: true }, ...handling], target);
	const jobs = item.progress.jobs ?? [];
	if (jobs.some((j) => j.state === "failure"))
		return compose(
			GLYPHS.failure,
			name,
			[{ text: failureDetail(item), cut: true }, ...moreFailed(item), ...handling],
			target,
		);
	const ms = now - (item.progress.startedAt ?? item.startedAt);
	const parts: Part[] = [];
	if (isGitHub(item) && item.progress.etaMs) parts.push({ text: etaCells(ms, item.progress.etaMs), drop: 1 });
	if (jobs.length) parts.push({ text: `${jobCounts(jobs).done}/${jobs.length}`, drop: 2 });
	// Whole minutes only, so the clock changes at most once a minute. None in the first minute.
	if (ms >= 60_000) parts.push({ text: formatShortDuration(ms), drop: 0 });
	return compose(GLYPHS.running, name, [...parts, ...handling], target);
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
