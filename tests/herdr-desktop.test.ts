import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DesktopApp,
	herdrAppHome,
	LAYOUT_SUFFIX,
	layoutUses,
	MOD_MARKER,
	MOD_NAME,
	patchAgentsMod,
	swapMod,
} from "../src/herdr/desktop-app.ts";
import { DesktopLabels, detectHerdrDesktop, labelArgs, UNTIL_LABEL, type Run } from "../src/herdr/desktop.ts";
import { FIRST_BACKOFF_MS } from "../src/herdr/client.ts";
import { HerdrSidebar, TTL_MS } from "../src/herdr/sidebar.ts";
import type { DockItem } from "../src/ui/dock.ts";
import { harness } from "./harness.ts";
import { FakeClock, plainTheme, until } from "./helpers.ts";

const NOW = 1_700_000_400_000;

/** The parts of Herdr's shipped agents mod that the patch hooks into. */
const AGENTS_SOURCE = `import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, openOverlay } from "herdr";

export default class Agents extends View {
  subRow(t, s, shown, compact) {
    return h_flex().child(s.t.address);
  }

  render(cx) {
    const row = (a, i, subs = []) => {
      return h_flex().child(a.address);
    };
    openOverlay({ mod: "agents" });
    return v_flex().children(agents().map((a, i) => row(a, i)));
  }
}
`;

const MAIN_LAYOUT = {
	id: "root",
	type: "row",
	children: [
		{
			id: "sidebar",
			type: "column",
			children: [
				{ id: "spaces", type: "block", content: { mod: "spaces" } },
				{ id: "agents", type: "block", content: { mod: "agents" } },
			],
		},
		{ id: "main", type: "block", content: { tab: "active" } },
	],
};

const running: DockItem = {
	id: "m1",
	kind: "gh_run",
	status: "running",
	description: "m1",
	paused: false,
	startedAt: NOW - 250_000,
	progress: { title: "CI #42" },
	activity: [],
	handling: false,
};

describe("Herdr desktop detection", () => {
	it("finds pi's herdr-core terminal from HC_TERMINAL_ID", () => {
		assert.deepEqual(detectHerdrDesktop({ HC_TERMINAL_ID: "t2", HC_TERMINAL_SOCKET: "/tmp/hc.sock" }), {
			terminal: "t2",
		});
	});

	it("leaves pi to the Herdr TUI when that runs inside the desktop app", () => {
		const env = { HC_TERMINAL_ID: "t2", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p1" };
		assert.equal(detectHerdrDesktop(env), undefined);
	});

	it("is undefined outside the desktop app", () => {
		assert.equal(detectHerdrDesktop({}), undefined);
		assert.equal(detectHerdrDesktop({ HC_TERMINAL_ID: " " }), undefined);
	});
});

describe("Herdr desktop labels", () => {
	it("turns tokens into pi-monitor.* labels, with an expiry while something shows", () => {
		assert.deepEqual(labelArgs("t2", { mon: "◐ CI #42", mon_fail: null }, NOW + TTL_MS, true), [
			"label",
			"t2",
			"pi-monitor.mon=◐ CI #42",
			"pi-monitor.mon_fail=",
			`${UNTIL_LABEL}=${NOW + TTL_MS}`,
		]);
	});

	it("removes the expiry with the last token, so pi leaves no labels behind", () => {
		assert.deepEqual(labelArgs("t2", { mon: null }, undefined, false), [
			"label",
			"t2",
			"pi-monitor.mon=",
			`${UNTIL_LABEL}=`,
		]);
	});

	it("keeps the expiry when only a count goes and $mon still shows", () => {
		assert.deepEqual(labelArgs("t2", { mon_ok: null }, undefined, true), ["label", "t2", "pi-monitor.mon_ok="]);
	});

	it("labels pi's terminal through the sidebar and clears every label when it stops", async () => {
		const clock = new FakeClock(NOW);
		const calls: string[][] = [];
		const labels = new DesktopLabels({
			terminal: "t2",
			run: async (command, args) => {
				calls.push([command, ...args]);
				return { code: 0, stdout: "", stderr: "" };
			},
			log: () => {},
			now: () => clock.now(),
		});
		const sidebar = new HerdrSidebar({ send: labels.send, items: () => [running], clock });
		sidebar.update();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, [
			[
				"hc",
				"label",
				"t2",
				"pi-monitor.mon=◐ CI #42 4m",
				"pi-monitor.mon_fail=",
				"pi-monitor.mon_run=",
				"pi-monitor.mon_wait=",
				"pi-monitor.mon_ok=",
				`${UNTIL_LABEL}=${NOW + TTL_MS}`,
			],
		]);
		await sidebar.stop();
		assert.deepEqual(calls.at(-1), ["hc", "label", "t2", "pi-monitor.mon=", `${UNTIL_LABEL}=`]);
	});

	it("backs off after a failed hc call instead of starting a process every second", async () => {
		const clock = new FakeClock(NOW);
		let calls = 0;
		const logs: string[] = [];
		const labels = new DesktopLabels({
			terminal: "t2",
			run: async () => {
				calls++;
				return { code: -1, stdout: "", stderr: "spawn hc ENOENT" };
			},
			log: (m) => logs.push(m),
			now: () => clock.now(),
		});
		assert.equal(await labels.send({ mon: "◐ CI" }, TTL_MS), false);
		assert.equal(await labels.send({ mon: "◐ CI" }, TTL_MS), false);
		assert.equal(calls, 1, "the second send waits for the backoff");
		assert.match(logs[0]!, /hc label failed \(spawn hc ENOENT\)/);
		clock.advance(FIRST_BACKOFF_MS);
		await labels.send({ mon: "◐ CI" }, TTL_MS);
		assert.equal(calls, 2);
	});
});

describe("Herdr desktop agents mod patch", () => {
	it("marks the mod as pi-monitor's on its first line", () => {
		assert.ok(patchAgentsMod(AGENTS_SOURCE).startsWith(MOD_MARKER));
	});

	it("wraps every agent row and sub-agent row with the monitor line and keeps the originals", () => {
		const patched = patchAgentsMod(AGENTS_SOURCE);
		assert.match(patched, /const row = \(\.\.\.args\) => piMonitorRow\(rowBase\(\.\.\.args\), args\[0\]\?\.address/);
		assert.match(patched, /const rowBase = \(a, i, subs = \[\]\) => \{/);
		assert.match(patched, /subRow\(\.\.\.args\) \{\n {4}const s = args\[1\];/);
		assert.match(patched, /subRowBase\(t, s, shown, compact\) \{/);
	});

	it("imports what the monitor line uses under its own names, after the mod's imports", () => {
		const patched = patchAgentsMod(AGENTS_SOURCE);
		const lastOriginalImport = patched.indexOf('from "herdr";');
		assert.ok(patched.indexOf("piMonitorTerminals } from") === -1);
		assert.ok(patched.indexOf("terminals as piMonitorTerminals") > lastOriginalImport);
		assert.ok(patched.includes('labels["pi-monitor.until"]'), "reads the expiry label");
	});

	it("patches once: setup run again leaves a patched mod as it is", () => {
		const once = patchAgentsMod(AGENTS_SOURCE);
		assert.equal(patchAgentsMod(once), once);
	});

	it("refuses an agents mod without the rows it hooks into, instead of breaking it", () => {
		assert.throws(() => patchAgentsMod(AGENTS_SOURCE.replace("subRow(", "kidRow(")), /no row and subRow/);
	});
});

describe("Herdr desktop layouts", () => {
	it("finds and swaps the agents block anywhere in the layout tree, floating blocks too", () => {
		const layout = structuredClone({ ...MAIN_LAYOUT, floating: [{ id: "f", content: { mod: "agents" } }] });
		assert.equal(layoutUses(layout, "agents"), true);
		assert.equal(swapMod(layout, "agents", MOD_NAME), 2);
		assert.equal(layoutUses(layout, "agents"), false);
		assert.equal(layoutUses(layout, MOD_NAME), true);
		assert.equal(layoutUses(layout, "spaces"), true, "other blocks stay");
	});

	it("uses HERDR_APP_HOME, else ~/.config/herdr-app", () => {
		assert.equal(herdrAppHome({ HERDR_APP_HOME: "/x" }, "/home/me"), "/x");
		assert.equal(herdrAppHome({}, "/home/me"), "/home/me/.config/herdr-app");
	});
});

/** A herdr-app and hc on a temp folder: clones, switches and checks like the real app. */
function fakeApp(options: { check?: RunResult } = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-monitor-desktop-"));
	const folder = join(home, ".config", "herdr-app");
	mkdirSync(join(folder, "mods", "agents"), { recursive: true });
	mkdirSync(join(folder, "layouts"), { recursive: true });
	writeFileSync(join(folder, "mods", "agents", "main.js"), AGENTS_SOURCE);
	writeFileSync(join(folder, "mods", "agents", "mod.json"), JSON.stringify({ place: "none", title: "Agents" }));
	writeFileSync(join(folder, "layouts", "main.json"), JSON.stringify(MAIN_LAYOUT));
	const state = { layout: "main", calls: [] as string[], labels: {} as Record<string, string> };
	const run: Run = async (command, args) => {
		state.calls.push([command, ...args].join(" "));
		if (command === "hc") {
			for (const pair of args.slice(2)) {
				const [key, ...rest] = pair.split("=");
				if (rest.join("=")) state.labels[key!] = rest.join("=");
				else delete state.labels[key!];
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		const [verb, name, json] = args;
		if (verb === "status") return { code: 0, stdout: JSON.stringify({ layout: state.layout }), stderr: "" };
		if (verb === "check") return options.check ?? { code: 0, stdout: `check passed: ${name}`, stderr: "" };
		const params = JSON.parse(json ?? "{}") as { name: string; as: string };
		if (name === "mod.clone") {
			const to = join(folder, "mods", params.as);
			if (existsSync(to)) return { code: 1, stdout: '{"error":"cannot clone mod: File exists"}', stderr: "" };
			cpSync(join(folder, "mods", params.name), to, { recursive: true });
			const main = join(to, "main.js");
			writeFileSync(main, readFileSync(main, "utf8").replace(`mod: "${params.name}"`, `mod: "${params.as}"`));
		} else if (name === "layout.clone") {
			const layout = JSON.parse(readFileSync(join(folder, "layouts", `${params.name}.json`), "utf8"));
			const clone = { cloned_from: { name: params.name, version: "0.1.10" }, ...layout };
			writeFileSync(join(folder, "layouts", `${params.as}.json`), JSON.stringify(clone));
			state.layout = params.as;
		} else if (name === "layout.switch") state.layout = params.name;
		else return { code: 1, stdout: `{"error":"unknown command ${name}"}`, stderr: "" };
		return { code: 0, stdout: '{"ok":true}', stderr: "" };
	};
	const layout = (name: string) => JSON.parse(readFileSync(join(folder, "layouts", `${name}.json`), "utf8"));
	return { home, folder, state, run, layout, modFolder: join(folder, "mods", MOD_NAME) };
}

type RunResult = Awaited<ReturnType<Run>>;

describe("Herdr desktop app setup", () => {
	it("clones and patches the agents mod, then shows it in a clone of the shown layout", async () => {
		const app = fakeApp();
		const lines = await new DesktopApp({ env: {}, home: app.home, run: app.run }).setup();
		const main = readFileSync(join(app.modFolder, "main.js"), "utf8");
		assert.ok(main.startsWith(MOD_MARKER));
		assert.ok(main.includes(`mod: "${MOD_NAME}"`), "the sort menu opens the clone, not the shipped mod");
		assert.equal(app.state.layout, `main${LAYOUT_SUFFIX}`);
		assert.equal(layoutUses(app.layout(`main${LAYOUT_SUFFIX}`), MOD_NAME), true);
		assert.equal(layoutUses(app.layout("main"), MOD_NAME), false, "the shipped layout stays as it was");
		assert.ok(app.state.calls.some((c) => c.startsWith(`herdr-app check ${app.modFolder}`)));
		assert.match(lines.join("\n"), /Layout: now main-pi-monitor, a copy of main/);
	});

	it("refreshes its own mod and reuses its layout when run again", async () => {
		const app = fakeApp();
		const desktop = new DesktopApp({ env: {}, home: app.home, run: app.run });
		await desktop.setup();
		app.state.layout = "main";
		const lines = await desktop.setup();
		assert.equal(app.state.layout, `main${LAYOUT_SUFFIX}`);
		assert.match(lines.join("\n"), /Switched to layout main-pi-monitor/);
		assert.equal(app.state.calls.filter((c) => c.includes("layout.clone")).length, 1);
	});

	it("never replaces a mod folder that is not pi-monitor's", async () => {
		const app = fakeApp();
		mkdirSync(app.modFolder, { recursive: true });
		writeFileSync(join(app.modFolder, "main.js"), "// someone else's\n");
		await assert.rejects(new DesktopApp({ env: {}, home: app.home, run: app.run }).setup(), /not pi-monitor's/);
		assert.equal(readFileSync(join(app.modFolder, "main.js"), "utf8"), "// someone else's\n");
	});

	it("deletes the patched mod again when Herdr's check fails, and says why", async () => {
		const app = fakeApp({ check: { code: 1, stdout: "", stderr: "TypeError: x is not a function" } });
		await assert.rejects(
			new DesktopApp({ env: {}, home: app.home, run: app.run }).setup(),
			/herdr-app check .* failed: TypeError: x is not a function/,
		);
		assert.equal(existsSync(app.modFolder), false);
	});

	it("says so when the shown layout has no agents list", async () => {
		const app = fakeApp();
		writeFileSync(join(app.folder, "layouts", "bare.json"), JSON.stringify({ id: "root", type: "row" }));
		app.state.layout = "bare";
		const lines = await new DesktopApp({ env: {}, home: app.home, run: app.run }).setup();
		assert.match(lines.join("\n"), /Layout bare has no agents list/);
		assert.equal(app.state.layout, "bare");
	});

	it("switches back to the layout it came from and deletes both clones when turned off", async () => {
		const app = fakeApp();
		const desktop = new DesktopApp({ env: {}, home: app.home, run: app.run });
		await desktop.setup();
		const lines = await desktop.remove();
		assert.equal(app.state.layout, "main");
		assert.equal(existsSync(join(app.folder, "layouts", `main${LAYOUT_SUFFIX}.json`)), false);
		assert.equal(existsSync(app.modFolder), false);
		assert.equal(existsSync(join(app.folder, "mods", "agents", "main.js")), true, "the shipped mod stays");
		assert.match(lines.join("\n"), /back to layout main/);
	});

	it("keeps the mod when a layout of the user's own still uses it", async () => {
		const app = fakeApp();
		const desktop = new DesktopApp({ env: {}, home: app.home, run: app.run });
		await desktop.setup();
		const mine = structuredClone(MAIN_LAYOUT);
		swapMod(mine, "agents", MOD_NAME);
		writeFileSync(join(app.folder, "layouts", "mine.json"), JSON.stringify(mine));
		const lines = await desktop.remove();
		assert.equal(existsSync(app.modFolder), true);
		assert.match(lines.join("\n"), /layout mine still uses it/);
	});
});

describe("/monitors herdr in the Herdr desktop app", () => {
	async function session(app: ReturnType<typeof fakeApp>) {
		const notes: { text: string; type: string | undefined }[] = [];
		const ui = {
			theme: plainTheme,
			setWidget: () => {},
			setStatus: () => {},
			setTitle: () => {},
			notify: (text: string, type?: string) => notes.push({ text, type }),
		};
		const h = harness({
			ui,
			overrides: { home: app.home, env: { HC_TERMINAL_ID: "t2" }, herdrRun: app.run },
		});
		await h.fire("session_start", { reason: "startup" });
		return { h, notes, command: (args: string) => h.commands.monitors!(args, h.ctx) };
	}

	it("shows the startup note in the desktop app too", async () => {
		const { notes } = await session(fakeApp());
		assert.ok(notes.some((n) => n.text.includes("/monitors herdr")));
	});

	it("installs the mod, switches the layout and reports it", async () => {
		const app = fakeApp();
		const { notes, command } = await session(app);
		await command("herdr");
		assert.equal(app.state.layout, `main${LAYOUT_SUFFIX}`);
		const text = notes.at(-1)!.text;
		assert.match(text, /Herdr app agents list on/);
		assert.equal(notes.at(-1)!.type, "info");
		await command("herdr status");
		assert.match(notes.at(-1)!.text, /pi runs in terminal t2/);
		assert.match(notes.at(-1)!.text, /Layout: main-pi-monitor, shows the monitor agents list/);
	});

	it("labels pi's terminal while on and takes every label back when turned off", async () => {
		const app = fakeApp();
		const { command, h } = await session(app);
		await command("herdr");
		try {
			await h.call("monitor", { command: "sleep 30", description: "dev server" });
			// The first report went out at setup: the next one waits for the one-second pace.
			await until(() => Boolean(app.state.labels["pi-monitor.mon"]));
			assert.match(app.state.labels["pi-monitor.mon"]!, /dev server/);
			assert.ok(Number(app.state.labels[UNTIL_LABEL]) > Date.now());
			await command("herdr off");
			assert.deepEqual(app.state.labels, {});
			assert.equal(app.state.layout, "main");
			assert.equal(existsSync(app.modFolder), false);
		} finally {
			await h.fire("session_shutdown", { reason: "quit" });
		}
	});
});
