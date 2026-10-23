// A scripted story of fake monitors for the README recording of the dock. Pure: time in, dock items out.
//
//   0 s    CI #42 starts (install, unit tests). dev server is chatty. yarn dev starts on probation.
//   5 s    unit tests fail: red glow, pi is on it.
//   8 s    re-run, then e2e.
//   9 s    yarn dev moves to the background.
//   13 s   CI goes green: flash, dissolve into `✓ CI #42 green in 6m02s`.
//   13.5 s yarn dev is stopped.
//   24 s   everything but the dev server has faded out, the loop starts again.
import type { Beat } from "../src/registry.ts";
import type { Job } from "../src/sources/types.ts";
import type { DockItem } from "../src/ui/dock.ts";

/** Loop length in ms. A multiple of the 6 s border sweep, so the loop has no visible seam. */
export const LOOP_MS = 24_000;
/** Story time 0, aligned to the loop. */
export const T0 = Date.UTC(2026, 0, 1);

const s = (seconds: number) => T0 + seconds * 1000;

function rng(seed: number): () => number {
	return () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}

const REQUESTS = [
	"GET /api/users 200 in 12ms",
	"GET /api/session 200 in 4ms",
	"POST /api/login 302 in 41ms",
	"GET /assets/index-4f2a.js 304 in 2ms",
	"GET /api/projects?limit=20 200 in 18ms",
	"PATCH /api/users/42 200 in 23ms",
	"GET /health 200 in 1ms",
];

interface Line extends Beat {
	text: string;
}

/** One loop of dev server requests, repeated before and after so the heartbeat has no seam. */
const DEV_LINES: Line[] = (() => {
	const random = rng(7);
	const loop: Line[] = [];
	for (let t = 0.6; t < LOOP_MS / 1000 - 0.5;) {
		loop.push({ at: t * 1000, amp: 1, text: REQUESTS[Math.floor(random() * REQUESTS.length)]! });
		if (random() < 0.25) loop.push({ at: (t + 0.25) * 1000, amp: 0.55, text: REQUESTS[0]! });
		t += 1.1 + random() * 2.2;
	}
	return [-1, 0, 1].flatMap((k) => loop.map((l) => ({ ...l, at: T0 + l.at + k * LOOP_MS })));
})();

const YARN_LINES: Line[] = [
	[1.1, "yarn run v1.22.22"],
	[1.4, "$ vite --host"],
	[1.9, "VITE v5.4.2  ready in 412 ms"],
	[2.2, "➜  Local:   http://localhost:5173/"],
	[3.4, "hmr update /src/auth/session.ts"],
	[5.3, "hmr update /src/auth/session.ts (x2)"],
	[7.4, "page reload src/main.tsx"],
	[9.6, "hmr update /src/auth/validate.ts"],
	[11.8, "hmr update /src/components/LoginForm.tsx"],
].map(([t, text], i) => ({ at: s(t as number), amp: i < 4 ? 0.55 : 1, text: text as string }));

function upTo(lines: readonly Line[], now: number): Pick<DockItem, "beats" | "lastLine" | "lastLineAt"> {
	const seen = lines.filter((l) => l.at <= now);
	const last = seen.at(-1);
	return {
		beats: seen.map(({ at, amp }) => ({ at, amp })),
		...(last ? { lastLine: last.text, lastLineAt: last.at } : {}),
	};
}

const base = (): Pick<DockItem, "paused" | "activity" | "handling"> => ({
	paused: false,
	activity: [],
	handling: false,
});

function ci(t: number, now: number): DockItem | undefined {
	if (t >= 23) return undefined;
	const job = (name: string, state: Job["state"], step?: string): Job => ({ name, state, ...(step ? { step } : {}) });
	const done = [job("build", "success"), job("lint", "success")];
	let jobs: Job[];
	if (t < 2) jobs = [...done, job("test", "running", "Install dependencies"), job("e2e", "queued")];
	else if (t < 5) jobs = [...done, job("test", "running", "Run unit tests"), job("e2e", "queued")];
	else if (t < 8) jobs = [...done, job("test", "failure", "Run unit tests"), job("e2e", "queued")];
	else if (t < 10.5) jobs = [...done, job("test", "running", "Re-run unit tests"), job("e2e", "queued")];
	else if (t < 13) jobs = [...done, job("test", "success"), job("e2e", "running", "Playwright · chromium")];
	else jobs = [...done, job("test", "success"), job("e2e", "success")];
	// The run's own clock runs fast so the ETA bar fills within the story: 4m10s at 0 s, 6m02s at 13 s.
	const elapsed = (250 + (Math.min(t, 13) * 112) / 13) * 1000;
	const item: DockItem = {
		...base(),
		id: "ci",
		kind: "gh_run",
		description: "CI for PR #42",
		status: t < 13 ? "running" : "success",
		startedAt: s(0),
		handling: t >= 5.6 && t < 9.5,
		progress: {
			title: "CI #42",
			url: "https://github.com/acme/app/actions/runs/42",
			jobs,
			etaMs: 360_000,
			startedAt: Math.min(now, s(13)) - elapsed,
		},
	};
	if (t >= 5 && t < 8) item.failingSince = s(5);
	if (t >= 13) {
		item.endedAt = s(13);
		item.summary = "CI #42 green in 6m02s";
	}
	return item;
}

function yarn(t: number, now: number): DockItem | undefined {
	if (t < 1 || t >= 23.5) return undefined;
	const item: DockItem = {
		...base(),
		id: "yarn",
		kind: "command",
		description: "yarn dev",
		status: t < 13.5 ? "running" : "stopped",
		startedAt: s(1),
		progress: {},
		...upTo(YARN_LINES, Math.min(now, s(13.5))),
	};
	if (t < 9) item.probationUntil = s(9);
	if (t >= 13.5) {
		item.endedAt = s(13.5);
		item.summary = "stopped by the user after 12s";
	}
	return item;
}

function devServer(now: number): DockItem {
	return {
		...base(),
		id: "dev",
		kind: "command",
		description: "dev server",
		status: "running",
		// Running for hours: the clock shows `2h14m` for the whole loop, so it does not jump back at the seam.
		startedAt: s(-(2 * 3600 + 14 * 60 + 5)),
		progress: {},
		...upTo(DEV_LINES, now),
	};
}

/** The dock at `ms` into the loop. */
export function story(ms: number): { now: number; items: DockItem[]; savedTokens: number } {
	const now = T0 + ms;
	const t = ms / 1000;
	const items = [ci(t, now), devServer(now), yarn(t, now)].filter((i): i is DockItem => i !== undefined);
	// A fixed savings meter, so it does not jump back at the seam either.
	return { now, items, savedTokens: 6_200 };
}
