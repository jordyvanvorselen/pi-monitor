import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Attention, BLOCKED_EVENT, GRACE_MS } from "../src/herdr/attention.ts";
import { HerdrSidebar, MIN_INTERVAL_MS, REFRESH_MS, SOURCE, TTL_MS } from "../src/herdr/sidebar.ts";
import { capChars, MAX_TOKEN_CHARS, paneToken } from "../src/herdr/tokens.ts";
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

	it("puts failures first, then running GitHub runs, then other running monitors, and counts the other running ones", () => {
		assert.equal(paneToken([devServer, ci, failing], NOW), "✗ e2e #17 checkout failed +2");
		assert.equal(paneToken([devServer, ci], NOW), "◐ CI #42 3/5 · 4m +1");
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
		assert.equal(paneToken([devServer, green], NOW), "✓ CI #42 green in 6m02s +1");
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

	it("stays within Herdr's 80 characters and keeps the +N count", () => {
		const long = { ...ci, progress: { title: "x".repeat(120), jobs } };
		const token = paneToken([long, devServer], NOW)!;
		assert.equal(Array.from(token).length, MAX_TOKEN_CHARS);
		assert.match(token, /…\s\+1$/);
		assert.equal(capChars("✓".repeat(81), 80).length, 80);
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
	it("reports only the pane token, with one fixed source and a TTL", async () => {
		const { sidebar, settle, requests } = sidebarSetup([ci]);
		sidebar.update();
		await settle();
		assert.deepEqual(requests, [
			{
				method: "pane.report_metadata",
				params: { pane_id: "w1:p1", source: SOURCE, tokens: { mon: "◐ CI #42 3/5 · 4m" }, ttl_ms: TTL_MS },
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

	it("clears its token when stopped", async () => {
		const { sidebar, settle, requests } = sidebarSetup([ci]);
		sidebar.update();
		await settle();
		await sidebar.stop();
		assert.deepEqual(
			requests.slice(1).map((r) => r.params.tokens),
			[{ mon: null }],
		);
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
