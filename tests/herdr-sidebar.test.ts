import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Attention, BLOCKED_EVENT, GRACE_MS } from "../src/herdr/attention.ts";
import { HerdrSidebar, MIN_INTERVAL_MS, REFRESH_MS, SOURCE, TTL_MS } from "../src/herdr/sidebar.ts";
import { capChars, countTokens, etaCells, MAX_TOKEN_CHARS, paneToken } from "../src/herdr/tokens.ts";
import type { Job } from "../src/sources/types.ts";
import type { DockItem } from "../src/ui/dock.ts";
import { FakeClock } from "./helpers.ts";

const NOW = 1_700_000_400_000;

function item(partial: Partial<DockItem> & Pick<DockItem, "id" | "kind" | "status">): DockItem {
	return {
		description: partial.id,
		paused: false,
		startedAt: NOW - 250_000,
		progress: {},
		activity: [],
		handling: false,
		...partial,
	};
}

const jobs: Job[] = [
	{ name: "build", state: "success" },
	{ name: "lint", state: "success" },
	{ name: "test", state: "success" },
	{ name: "e2e", state: "running" },
	{ name: "deploy", state: "queued" },
];
const ci = item({ id: "m1", kind: "gh_run", status: "running", progress: { title: "CI #42", jobs } });
const devServer = item({
	id: "m2",
	kind: "command",
	status: "running",
	description: "dev server",
	startedAt: NOW - 600_000,
});
const failing = item({
	id: "m3",
	kind: "gh_run",
	status: "running",
	progress: {
		title: "e2e #17",
		jobs: [
			{ name: "checkout", state: "failure" },
			{ name: "cart", state: "running" },
		],
	},
});

describe("Herdr tokens", () => {
	it("shows a running GitHub run with job counts and whole minutes: ◐ CI #42 3/5 · 4m", () => {
		assert.equal(paneToken([ci], NOW), "◐ CI #42 3/5 · 4m");
	});

	it("leaves the clock out in the first minute, so the token does not change every second", () => {
		assert.equal(paneToken([{ ...ci, startedAt: NOW - 30_000 }], NOW), "◐ CI #42 3/5");
	});

	it("puts failures first, then running GitHub runs, then other running monitors, without a +N count", () => {
		assert.equal(paneToken([devServer, ci, failing], NOW), "✗ e2e #17 checkout failed");
		assert.equal(paneToken([devServer, ci], NOW), "◐ CI #42 3/5 · 4m");
		assert.equal(paneToken([devServer], NOW), "◐ dev server · 10m");
	});

	it("shows the finish moment for as long as the dock does, before other running monitors", () => {
		const green = item({
			id: "m1",
			kind: "gh_run",
			status: "success",
			progress: { title: "CI #42" },
			summary: "CI #42 green in 6m02s",
			endedAt: NOW - 2_000,
		});
		assert.equal(paneToken([devServer, green], NOW), "✓ CI #42 green in 6m02s");
		assert.equal(paneToken([devServer, green], NOW + 9_000), "◐ dev server · 10m");
		assert.equal(paneToken([green], NOW + 9_000), null);
	});

	it("marks commands on probation and paused monitors with their own glyph", () => {
		assert.equal(
			paneToken(
				[item({ id: "m4", kind: "command", status: "running", description: "yarn dev", probationUntil: NOW + 9_000 })],
				NOW,
			),
			"⏳ yarn dev",
		);
		assert.equal(paneToken([{ ...devServer, paused: true }], NOW), "‖ dev server paused");
	});

	it("stays within Herdr's 80 characters by cutting the name, keeping the glyph, bar and job counts", () => {
		const long = { ...ci, progress: { title: "x".repeat(120), jobs, etaMs: 500_000 } };
		const token = paneToken([long, devServer], NOW)!;
		assert.equal(Array.from(token).length, MAX_TOKEN_CHARS);
		assert.match(token, /^◐ x+… ▰▰▱▱▱ 3\/5 · 4m$/);
		assert.equal(capChars("✓".repeat(81), 80).length, 80);
		const failedLong = { ...failing, progress: { ...failing.progress, title: "y".repeat(120) } };
		assert.match(paneToken([failedLong], NOW)!, /^✗ y+…$/, "other states are cut at the end and keep their glyph");
	});

	it("draws a 5-cell ETA bar from the dock's estimate for GitHub runs: ◐ CI #42 ▰▰▱▱▱ 3/5 · 4m", () => {
		const withEta = (etaMs: number) => ({ ...ci, progress: { ...ci.progress, etaMs } });
		assert.equal(paneToken([withEta(500_000)], NOW), "◐ CI #42 ▰▰▱▱▱ 3/5 · 4m", "250 s of ~500 s: two cells");
		assert.equal(paneToken([withEta(1_000_000)], NOW), "◐ CI #42 ▰▱▱▱▱ 3/5 · 4m");
		assert.equal(etaCells(0, 600_000), "▱▱▱▱▱");
		assert.equal(etaCells(599_000, 600_000), "▰▰▰▰▱");
	});

	it("never fills the last cell while the run is still going, also past the ETA", () => {
		const late = { ...ci, progress: { ...ci.progress, etaMs: 100_000 } };
		assert.equal(paneToken([late], NOW), "◐ CI #42 ▰▰▰▰▱ 3/5 · 4m");
	});

	it("only changes when a whole cell fills, so the once-a-second throttle stays quiet", () => {
		const run = { ...ci, progress: { ...ci.progress, etaMs: 500_000 } };
		assert.equal(paneToken([run], NOW), paneToken([run], NOW + 9_000));
		assert.notEqual(paneToken([run], NOW), paneToken([run], NOW + 60_000));
	});

	it("shows no bar without an ETA, for other monitors, and for failure and finish moments", () => {
		assert.equal(paneToken([ci], NOW), "◐ CI #42 3/5 · 4m");
		assert.equal(paneToken([{ ...devServer, progress: { etaMs: 60_000 } }], NOW), "◐ dev server · 10m");
		const failingEta = { ...failing, progress: { ...failing.progress, etaMs: 500_000 } };
		assert.equal(paneToken([failingEta], NOW), "✗ e2e #17 checkout failed");
		const green = item({
			id: "m1",
			kind: "gh_run",
			status: "success",
			progress: { title: "CI #42", etaMs: 500_000 },
			summary: "CI #42 green in 6m02s",
			endedAt: NOW - 1_000,
		});
		assert.equal(paneToken([green], NOW), "✓ CI #42 green in 6m02s");
	});

	it("counts monitors per state with the same glyphs as $mon: ✗1 ◐2 ⏳1", () => {
		const probation = item({ id: "m4", kind: "command", status: "running", probationUntil: NOW + 9_000 });
		assert.deepEqual(countTokens([failing, ci, devServer, probation], NOW), {
			mon_fail: "✗1",
			mon_run: "◐2",
			mon_wait: "⏳1",
			mon_ok: null,
		});
	});

	it("counts runs waiting for a runner as waiting, finish moments as ok, and leaves stopped ones out", () => {
		const queued = item({
			id: "m5",
			kind: "gh_pr",
			status: "running",
			progress: { jobs: [{ name: "build", state: "queued" }] },
		});
		const green = item({ id: "m6", kind: "gh_run", status: "success", endedAt: NOW - 1_000 });
		const timedOut = item({ id: "m7", kind: "url", status: "timeout", endedAt: NOW - 1_000 });
		const stopped = item({ id: "m8", kind: "command", status: "stopped", endedAt: NOW - 1_000 });
		assert.deepEqual(countTokens([queued, green, timedOut, stopped], NOW), {
			mon_fail: "✗1",
			mon_run: null,
			mon_wait: "⏳1",
			mon_ok: "✓1",
		});
	});

	it("hides the counts row with fewer than two monitors on screen", () => {
		const none = { mon_fail: null, mon_run: null, mon_wait: null, mon_ok: null };
		assert.deepEqual(countTokens([], NOW), none);
		assert.deepEqual(countTokens([failing], NOW), none, "$mon already says it all");
		const expired = item({ id: "m6", kind: "gh_run", status: "success", endedAt: NOW - 60_000 });
		assert.deepEqual(countTokens([ci, expired], NOW), none, "a finished row that left the dock does not count");
	});

	it("is null without monitors, so the sidebar row disappears", () => {
		assert.equal(paneToken([], NOW), null);
	});
});

function sidebarSetup(items: DockItem[], options: { fail?: boolean } = {}) {
	const clock = new FakeClock(NOW);
	const requests: { method: string; params: Record<string, unknown> }[] = [];
	const state = { fail: options.fail ?? false };
	const sidebar = new HerdrSidebar({
		request: async (method, params) => {
			requests.push({ method, params });
			return state.fail ? undefined : { result: { type: "ok" } };
		},
		paneId: "w1:p1",
		items: () => items,
		clock,
	});
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const step = async (ms: number) => {
		clock.advance(ms);
		await settle();
	};
	const panes = () => requests.filter((r) => r.method === "pane.report_metadata").map((r) => r.params);
	return { sidebar, clock, requests, state, settle, step, panes };
}

describe("Herdr sidebar sync", () => {
	it("reports $mon and the count tokens in one pane report, with one fixed source and a TTL", async () => {
		const { sidebar, settle, requests } = sidebarSetup([ci]);
		sidebar.update();
		await settle();
		assert.deepEqual(requests, [
			{
				method: "pane.report_metadata",
				params: {
					pane_id: "w1:p1",
					source: SOURCE,
					tokens: { mon: "◐ CI #42 3/5 · 4m", mon_fail: null, mon_run: null, mon_wait: null, mon_ok: null },
					ttl_ms: TTL_MS,
				},
			},
		]);
	});

	it("sends nothing while the tokens stay the same", async () => {
		const { sidebar, settle, step, requests } = sidebarSetup([ci]);
		sidebar.update();
		await settle();
		for (let i = 0; i < 10; i++) await step(MIN_INTERVAL_MS);
		assert.equal(requests.length, 1);
	});

	it("sends at most once a second: a burst of changes becomes one trailing report", async () => {
		const items = [ci];
		const { sidebar, settle, step, panes } = sidebarSetup(items);
		sidebar.update();
		await settle();
		for (let done = 3; done <= 5; done++) {
			items[0] = {
				...ci,
				progress: { title: "CI #42", jobs: jobs.map((j, i) => ({ ...j, state: i < done ? "success" : j.state })) },
			};
			sidebar.update();
			await settle();
		}
		assert.equal(panes().length, 1, "changes within the second wait");
		await step(MIN_INTERVAL_MS);
		assert.equal(panes().length, 2);
		assert.equal(panes()[1]!.tokens && (panes()[1]!.tokens as Record<string, string>).mon, "◐ CI #42 5/5 · 4m");
	});

	it("sends only the tokens that changed: a second monitor shows the counts row, its end hides it again", async () => {
		const items: DockItem[] = [ci];
		const { sidebar, settle, step, panes } = sidebarSetup(items);
		sidebar.update();
		await settle();
		items.push(devServer);
		await step(MIN_INTERVAL_MS);
		assert.deepEqual(panes()[1]!.tokens, { mon_run: "◐2" });
		items.pop();
		await step(MIN_INTERVAL_MS);
		assert.deepEqual(panes()[2]!.tokens, { mon_run: null });
	});

	it("refreshes the TTL of every shown token, also the counts", async () => {
		const { sidebar, settle, step, panes } = sidebarSetup([ci, devServer]);
		sidebar.update();
		await settle();
		for (let t = 0; t < REFRESH_MS; t += MIN_INTERVAL_MS) await step(MIN_INTERVAL_MS);
		assert.equal(panes().length, 2);
		assert.deepEqual(panes()[1]!.tokens, { mon: "◐ CI #42 3/5 · 4m", mon_run: "◐2" });
		assert.equal(panes()[1]!.ttl_ms, TTL_MS);
	});

	it("refreshes the TTL while a token shows", async () => {
		const { sidebar, settle, step, panes } = sidebarSetup([ci]);
		sidebar.update();
		await settle();
		for (let t = 0; t < REFRESH_MS; t += MIN_INTERVAL_MS) await step(MIN_INTERVAL_MS);
		assert.equal(panes().length, 2);
		assert.equal(panes()[1]!.ttl_ms, TTL_MS);
	});

	it("clears the token with null when nothing is left, then stops ticking", async () => {
		const items: DockItem[] = [ci];
		const { sidebar, settle, step, requests } = sidebarSetup(items);
		sidebar.update();
		await settle();
		items.pop();
		await step(MIN_INTERVAL_MS);
		assert.deepEqual(
			requests.slice(1).map((r) => r.params.tokens),
			[{ mon: null }],
		);
		assert.ok(
			requests.slice(1).every((r) => !("ttl_ms" in r.params)),
			"a clear has no TTL",
		);
		await step(MIN_INTERVAL_MS);
		assert.equal(sidebar.ticking, false);
	});

	it("tries again on the next tick when Herdr was not reached", async () => {
		const { sidebar, settle, step, state, panes } = sidebarSetup([ci], { fail: true });
		sidebar.update();
		await settle();
		state.fail = false;
		await step(MIN_INTERVAL_MS);
		await step(MIN_INTERVAL_MS);
		assert.equal(panes().length, 2, "one failed and one good report, then quiet");
	});

	it("clears all its tokens when stopped", async () => {
		const { sidebar, settle, requests } = sidebarSetup([ci, devServer]);
		sidebar.update();
		await settle();
		await sidebar.stop();
		assert.deepEqual(
			requests.slice(1).map((r) => r.params.tokens),
			[{ mon: null, mon_run: null }],
		);
		assert.equal("ttl_ms" in requests[1]!.params, false);
		assert.equal(sidebar.ticking, false);
	});
});

describe("Herdr blocked mark", () => {
	function setup() {
		const clock = new FakeClock(NOW);
		const records = new Map<string, DockItem>();
		const emitted: { channel: string; data: { active: boolean; label?: string } }[] = [];
		const attention = new Attention({
			emit: (channel, data) => emitted.push({ channel, data }),
			get: (id) => records.get(id),
			clock,
		});
		const failed = item({ id: "m1", kind: "gh_run", status: "failure", progress: { title: "CI #42" }, endedAt: NOW });
		records.set("m1", failed);
		return { clock, records, emitted, attention, failed };
	}

	it("marks the pane after a short grace time when nobody handles the failure", () => {
		const { clock, emitted, attention, failed } = setup();
		attention.failed(failed);
		assert.equal(emitted.length, 0);
		clock.advance(GRACE_MS);
		assert.deepEqual(emitted, [{ channel: BLOCKED_EVENT, data: { active: true, label: "CI #42 failed" } }]);
	});

	it("does not mark the pane when the model picks the failure up within the grace time", () => {
		const { clock, emitted, attention, failed, records } = setup();
		attention.failed(failed);
		records.set("m1", { ...failed, handling: true });
		clock.advance(GRACE_MS);
		assert.equal(emitted.length, 0);
	});

	it("takes the mark back once when the model handles it, a re-run starts or the user types", () => {
		for (const resolve of ["handled", "rerun", "typed"] as const) {
			const { clock, emitted, attention, failed, records } = setup();
			attention.failed(failed);
			clock.advance(GRACE_MS);
			if (resolve === "handled") {
				records.set("m1", { ...failed, handling: true });
				attention.sync([]);
			} else if (resolve === "rerun") {
				attention.sync([item({ id: "m2", kind: "gh_run", status: "running", description: failed.description })]);
			} else attention.clearAll();
			attention.sync([]);
			attention.clearAll();
			assert.deepEqual(
				emitted.map((e) => e.data.active),
				[true, false],
				resolve,
			);
		}
	});
});
