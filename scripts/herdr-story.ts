// The Herdr scene of the README recording: the dock story (scripts/dock-story.ts) in the webapp pane, which is
// the tab on screen, and two more pi sessions in other spaces with a monitor each. The sidebar tokens, toasts and blocked marks
// come from pi-monitor's real Herdr code (HerdrSidebar, Attention, toastFor) on a virtual clock, with a fake
// Herdr that writes down what it receives.
//
//   0 s    CI #42 starts in webapp. The counts row shows next to the `$mon` row: two monitors run.
//   1 s    yarn dev starts on probation: `◐2 · ⏳1`.
//   1.5 s  the Backend Tests pi starts e2e #17. Its ETA bar fills.
//   5 s    unit tests fail: webapp's row turns red, `✗1 · ◐1 · ⏳1`. pi works on it 5.6–9.5 s.
//   2.5 s  the site pi starts Deploy #88.
//   9.2 s  e2e #17 fails: a red toast, and the Backend Tests pane is marked blocked 2 s later.
//   13 s   CI #42 goes green: `✓ CI #42 green in 6m02s`. No toast: Herdr shows none for the tab you look at.
//   13.2 s Deploy #88 goes green, with a toast. yarn dev is stopped at 13.5 s.
//   17 s   the user answers the Backend Tests pi: the blocked mark goes, that pi works until it reruns e2e.
//   23.5 s the finished rows are gone, the counts row too. The loop starts again.
import type { Clock } from "../src/delivery.ts";
import { Attention } from "../src/herdr/attention.ts";
import { toastFor } from "../src/herdr/integration.ts";
import { HerdrSidebar } from "../src/herdr/sidebar.ts";
import type { Job } from "../src/sources/types.ts";
import type { DockItem } from "../src/ui/dock.ts";
import { LOOP_MS, story, T0 } from "./dock-story.ts";

export { LOOP_MS, T0 };

/** How long a Herdr toast stays on screen in the recording. */
export const TOAST_MS = 3_600;
/** Time step of the simulation. Every story change lands on a multiple of it. */
export const STEP_MS = 50;

export type AgentState = "idle" | "working" | "blocked";

/** One pi session in a Herdr pane. */
interface Session {
	pane: string;
	/** The tab on screen. Herdr shows no toasts for it. */
	focused?: boolean;
	cwd: string;
	/** When in the second its sidebar ticks. Real sessions tick at any phase; this one is picked per pane. */
	phaseMs: number;
	monitors(ms: number): DockItem[];
	/** What pi itself reports to Herdr: working while the model runs. */
	state(t: number): Exclude<AgentState, "blocked">;
	/** When the user types into this pi, in seconds. */
	input: number[];
}

const s = (seconds: number) => T0 + seconds * 1000;

/** e2e #17 in the Backend Tests pane: starts at 1.5 s, fails at 9.2 s, lingers for the dock's 10 s. */
export const E2E_START = 1.5;
export const E2E_FAIL = 9.2;

function e2e(t: number, now: number): DockItem | undefined {
	if (t < E2E_START) return undefined;
	const job = (name: string, state: Job["state"]): Job => ({ name, state });
	const failed = t >= E2E_FAIL;
	// A fast clock again, so the bar fills: 2m10s when it shows up, 5m at the failure.
	const elapsed = (130 + ((Math.min(t, E2E_FAIL) - E2E_START) * 170) / (E2E_FAIL - E2E_START)) * 1000;
	return {
		id: "e2e",
		kind: "gh_run",
		description: "e2e for main",
		status: failed ? "failure" : "running",
		paused: false,
		activity: [],
		handling: false,
		startedAt: s(E2E_START),
		progress: {
			title: "e2e #17",
			url: "https://github.com/acme/api/actions/runs/17",
			jobs: [
				job("setup", "success"),
				job("api", "success"),
				job("checkout", failed ? "failure" : "running"),
				job("payments", "queued"),
			],
			etaMs: 360_000,
			startedAt: Math.min(now, s(E2E_FAIL)) - elapsed,
		},
		...(failed ? { endedAt: s(E2E_FAIL), summary: "checkout failed" } : {}),
	};
}

/** Deploy #88 in the site pane: starts at 2.5 s, goes green at 13.2 s and is gone 10 s later, before the loop ends. */
export const DEPLOY_START = 2.5;
export const DEPLOY_DONE = 13.2;

function deploy(t: number, now: number): DockItem | undefined {
	if (t < DEPLOY_START) return undefined;
	const done = t >= DEPLOY_DONE;
	const job = (name: string, state: Job["state"]): Job => ({ name, state });
	const elapsed = (40 + ((Math.min(t, DEPLOY_DONE) - DEPLOY_START) * 120) / (DEPLOY_DONE - DEPLOY_START)) * 1000;
	return {
		id: "deploy",
		kind: "gh_run",
		description: "Deploy for main",
		status: done ? "success" : "running",
		paused: false,
		activity: [],
		handling: false,
		startedAt: s(DEPLOY_START),
		progress: {
			title: "Deploy #88",
			url: "https://github.com/acme/site/actions/runs/88",
			jobs: [
				job("build", "success"),
				job("migrate", t < 7 ? "running" : "success"),
				job("release", done ? "success" : t < 7 ? "queued" : "running"),
			],
			etaMs: 180_000,
			startedAt: Math.min(now, s(DEPLOY_DONE)) - elapsed,
		},
		...(done ? { endedAt: s(DEPLOY_DONE), summary: "Deploy #88 green in 2m40s" } : {}),
	};
}

export const SESSIONS: readonly Session[] = [
	{
		pane: "webapp",
		focused: true,
		cwd: "/Users/dev/code/webapp",
		// Just after the half second, so it sees yarn dev go at 23.5 s and the counts row leaves before the loop ends.
		phaseMs: 550,
		monitors: (ms) => story(ms).items,
		// The dock's "pi is on it ↳" while pi fixes the failing test.
		state: (t) => (t >= 5.6 && t < 9.5 ? "working" : "idle"),
		input: [],
	},
	{
		pane: "backend",
		cwd: "/Users/dev/code/api",
		phaseMs: 300,
		monitors: (ms) => [e2e(ms / 1000, T0 + ms)].filter((i): i is DockItem => i !== undefined),
		// Works from the user's answer at 17 s until it starts the next e2e run, across the loop seam.
		state: (t) => (t < E2E_START || t >= 17 ? "working" : "idle"),
		input: [17],
	},
	{
		pane: "site",
		cwd: "/Users/dev/code/site",
		phaseMs: 800,
		monitors: (ms) => [deploy(ms / 1000, T0 + ms)].filter((i): i is DockItem => i !== undefined),
		state: () => "idle",
		input: [],
	},
];

/** `item` with every time moved by `by` ms: the same monitor one loop later. */
export function shiftItem(item: DockItem, by: number): DockItem {
	const out: DockItem = { ...item, startedAt: item.startedAt + by, progress: { ...item.progress } };
	if (item.endedAt !== undefined) out.endedAt = item.endedAt + by;
	if (item.failingSince !== undefined) out.failingSince = item.failingSince + by;
	if (item.probationUntil !== undefined) out.probationUntil = item.probationUntil + by;
	if (item.lastLineAt !== undefined) out.lastLineAt = item.lastLineAt + by;
	if (item.beats) out.beats = item.beats.map((b) => ({ ...b, at: b.at + by }));
	if (item.progress.startedAt !== undefined) out.progress.startedAt = item.progress.startedAt + by;
	return out;
}

/** A Clock whose time only moves when told to. */
export class VirtualClock implements Clock {
	private time: number;
	private timers: { at: number; fn: () => void; id: number }[] = [];
	private nextId = 1;

	constructor(start: number) {
		this.time = start;
	}

	now(): number {
		return this.time;
	}

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.push({ at: this.time + ms, fn, id });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers = this.timers.filter((t) => t.id !== handle);
	}

	/** Move to `time`, running every timer that is due on the way, in order. */
	async advanceTo(time: number): Promise<void> {
		for (;;) {
			const due = this.timers.filter((t) => t.at <= time).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			this.timers = this.timers.filter((t) => t !== due);
			this.time = due.at;
			due.fn();
			await settle();
		}
		this.time = time;
	}
}

/** Let promise chains (the sidebar's report) finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface Report {
	pane: string;
	/** ms into the loop. */
	at: number;
	tokens: Record<string, string | null>;
}

export interface Toast {
	pane: string;
	at: number;
	title: string;
	body: string;
	status: "success" | "failure" | "timeout";
}

export interface Timeline {
	reports: Report[];
	/** `herdr:blocked` events from Attention: +1 marks the pane, -1 takes a mark back. */
	blocked: { pane: string; at: number; delta: number }[];
	toasts: Toast[];
}

/**
 * Run every session through pi-monitor's Herdr code. What pi would send to Herdr is written down instead of
 * sent: `pane.report_metadata` tokens, `notification.show` toasts and the blocked marks. Two loops on one
 * clock: the second one, which the recording shows, starts with what the first one left in Herdr. Times in
 * the timeline count from the start of the first loop.
 */
export async function simulate(): Promise<Timeline> {
	const clock = new VirtualClock(T0);
	const timeline: Timeline = { reports: [], blocked: [], toasts: [] };
	const at = () => clock.now() - T0;
	const live = SESSIONS.map((session) => {
		let items: DockItem[] = [];
		const sidebar = new HerdrSidebar({
			request: async (_method, params) => {
				timeline.reports.push({ pane: session.pane, at: at(), tokens: { ...(params.tokens as Report["tokens"]) } });
				return { result: {} };
			},
			paneId: session.pane,
			items: () => items,
			clock,
		});
		// With `herdrAttention` on: a failure nobody handles marks the pane as blocked.
		const attention = new Attention({
			emit: (_channel, data) => timeline.blocked.push({ pane: session.pane, at: at(), delta: data.active ? 1 : -1 }),
			get: (id) => items.find((i) => i.id === id),
			clock,
		});
		return {
			session,
			sidebar,
			attention,
			set: (next: DockItem[]) => (items = next),
			get: () => items,
		};
	});

	for (let ms = 0; ms < 2 * LOOP_MS; ms += STEP_MS) {
		const loop = Math.floor(ms / LOOP_MS) * LOOP_MS;
		const t = ms - loop;
		// New monitor states first, then the sidebar timers that are due now: a change that lands on a tick shows.
		for (const { session, sidebar, attention, set, get } of live) {
			const before = new Map(get().map((i) => [i.id, i.status]));
			const items = set(session.monitors(t).map((i) => shiftItem(i, loop)));
			for (const item of items) {
				// What the extension does when the registry reports an end (UiController.ended, HerdrIntegration.ended).
				if (before.get(item.id) !== "running" || item.status === "running" || item.probationUntil !== undefined)
					continue;
				if (item.status === "success" || item.status === "failure" || item.status === "timeout")
					timeline.toasts.push({ pane: session.pane, at: ms, status: item.status, ...toastFor(item, session.cwd) });
				if (item.status === "failure" || item.status === "timeout") attention.failed(item);
			}
			if (session.input.some((at) => at * 1000 === t)) attention.clearAll();
			if (ms >= session.phaseMs) sidebar.update();
		}
		await clock.advanceTo(T0 + ms);
		await settle();
	}
	return timeline;
}

export interface AgentScene {
	pane: string;
	state: AgentState;
	tokens: Record<string, string | null>;
}

export interface Scene {
	ms: number;
	agents: AgentScene[];
	/** Toasts on screen, newest last, with how long they have been showing. None for the focused tab, like Herdr. */
	toasts: (Toast & { age: number })[];
}

/** What Herdr shows `ms` into the recorded (second) loop: every report and mark received so far. */
export function sceneAt(timeline: Timeline, ms: number): Scene {
	const t = ms;
	ms += LOOP_MS;
	const agents = SESSIONS.map((session): AgentScene => {
		const tokens: Record<string, string | null> = {};
		for (const r of timeline.reports) if (r.pane === session.pane && r.at <= ms) Object.assign(tokens, r.tokens);
		const marks = timeline.blocked
			.filter((b) => b.pane === session.pane && b.at <= ms)
			.reduce((sum, b) => sum + b.delta, 0);
		return { pane: session.pane, state: marks > 0 ? "blocked" : session.state(t / 1000), tokens };
	});
	const focused = new Set(SESSIONS.filter((s) => s.focused).map((s) => s.pane));
	const toasts = timeline.toasts
		.filter((toast) => !focused.has(toast.pane) && toast.at <= ms && ms < toast.at + TOAST_MS)
		.map((toast) => ({ ...toast, age: ms - toast.at }));
	return { ms: t, agents, toasts };
}
