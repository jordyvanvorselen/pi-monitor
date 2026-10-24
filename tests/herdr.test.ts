import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BLOCKED_EVENT, GRACE_MS } from "../src/herdr/attention.ts";
import { STARTUP_NOTE, type HerdrIntegration } from "../src/herdr/integration.ts";
import type { Registry } from "../src/registry.ts";
import { loadSettings, saveUserSetting } from "../src/settings.ts";
import { fakeHerdr } from "./fake-herdr.ts";
import { harness } from "./harness.ts";
import { plainTheme, until } from "./helpers.ts";

describe("pi-monitor settings file", () => {
	it("saves one key in the monitor section and keeps every other setting", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-monitor-home-"));
		const path = join(home, ".pi", "agent", "settings.json");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(path, JSON.stringify({ theme: "dark", monitor: { maxConcurrent: 3 } }));
		saveUserSetting("herdr", "on", home);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			theme: "dark",
			monitor: { maxConcurrent: 3, herdr: "on" },
		});
		assert.equal(loadSettings(home, home).herdr, "on");
		assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
		saveUserSetting("herdr", "off", home);
		assert.equal(loadSettings(home, home).herdr, "off");
	});

	it("leaves herdr unset until the user decides and ignores values other than on and off", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-monitor-home-"));
		assert.equal(loadSettings(home, home).herdr, undefined);
		assert.equal(loadSettings(home, home).herdrAttention, false);
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ monitor: { herdr: true } }));
		assert.equal(loadSettings(home, home).herdr, undefined);
	});

	it("refuses to overwrite a settings file that is not valid JSON", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-monitor-home-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), "{ broken");
		assert.throws(() => saveUserSetting("herdr", "on", home), /not valid JSON/);
		assert.equal(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"), "{ broken");
	});
});

function uiStub() {
	const notes: { text: string; type: string | undefined }[] = [];
	return {
		notes,
		ui: {
			theme: plainTheme,
			setWidget: () => {},
			setStatus: () => {},
			setTitle: () => {},
			notify: (text: string, type?: string) => notes.push({ text, type }),
		},
	};
}

async function setup(
	options: {
		herdr?: "on" | "off";
		attention?: boolean;
		inHerdr?: boolean;
		tui?: boolean;
		desktopNotifications?: boolean;
		reply?: Parameters<typeof fakeHerdr>[0];
	} = {},
) {
	const server = await fakeHerdr(options.reply);
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-herdr-env-"));
	const configPath = join(dir, "config.toml");
	const env: NodeJS.ProcessEnv =
		options.inHerdr === false
			? { HERDR_CONFIG_PATH: configPath }
			: {
					HERDR_ENV: "1",
					HERDR_SOCKET_PATH: server.socketPath,
					HERDR_PANE_ID: "w1:p1",
					HERDR_WORKSPACE_ID: "w1",
					HERDR_CONFIG_PATH: configPath,
					HERDR_BIN_PATH: "/nonexistent/herdr",
				};
	const stub = uiStub();
	const desktop: string[] = [];
	let internals: { registry: Registry; herdr: HerdrIntegration } | undefined;
	const h = harness({
		...(options.tui === false ? {} : { ui: stub.ui }),
		overrides: {
			env,
			notify: (title, body) => desktop.push(`${title}: ${body}`),
			expose: (i) => (internals = i),
		},
	});
	const monitor: Record<string, unknown> = {};
	if (options.herdr) monitor.herdr = options.herdr;
	if (options.attention) monitor.herdrAttention = true;
	if (options.desktopNotifications === false) monitor.desktopNotifications = false;
	if (Object.keys(monitor).length) {
		mkdirSync(join(h.home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(h.home, ".pi", "agent", "settings.json"), JSON.stringify({ monitor }));
	}
	const settingsFile = () => JSON.parse(readFileSync(join(h.home, ".pi", "agent", "settings.json"), "utf8"));
	const command = (args: string) => h.commands.monitors!(args, h.ctx);
	return { h, server, stub, desktop, configPath, settingsFile, command, internals: () => internals! };
}

describe("Herdr startup note", () => {
	it("shows once at startup inside Herdr while the user has not decided", async () => {
		const { h, stub, server } = await setup();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("session_start", { reason: "startup" });
		assert.deepEqual(stub.notes, [{ text: STARTUP_NOTE, type: "info" }]);
		assert.match(STARTUP_NOTE, /\/monitors herdr off/);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("stays away outside Herdr, outside the terminal UI, after a reload and once the user decided", async () => {
		const cases = [
			{ name: "outside Herdr", options: { inHerdr: false }, reason: "startup" },
			{ name: "print mode", options: { tui: false }, reason: "startup" },
			{ name: "reload", options: {}, reason: "reload" },
			{ name: "turned off", options: { herdr: "off" as const }, reason: "startup" },
			{ name: "turned on", options: { herdr: "on" as const }, reason: "startup" },
		];
		for (const { name, options, reason } of cases) {
			const { h, stub, server } = await setup(options);
			await h.fire("session_start", { reason });
			assert.deepEqual(stub.notes, [], name);
			await h.fire("session_shutdown", { reason: "quit" });
			await server.close();
		}
	});
});

describe("/monitors herdr", () => {
	it("offers herdr, herdr off and herdr status as arguments", async () => {
		const { h, server } = await setup();
		const complete = h.completions.monitors!;
		assert.deepEqual(
			(complete("") as { value: string }[]).map((i) => i.value),
			["herdr", "herdr off", "herdr status"],
		);
		assert.deepEqual(
			(complete("herdr o") as { value: string }[]).map((i) => i.value),
			["herdr off"],
		);
		assert.equal(complete("x"), null);
		await server.close();
	});

	it("turns the integration on, adds the rows to the Herdr config, reloads it and says what changed", async () => {
		const { h, server, stub, configPath, settingsFile, command } = await setup();
		writeFileSync(configPath, '[theme]\nname = "catppuccin"\n');
		await h.fire("session_start", { reason: "startup" });
		stub.notes.length = 0;
		await command("herdr");
		assert.equal(settingsFile().monitor.herdr, "on");
		assert.match(readFileSync(configPath, "utf8"), /token = "\$mon"/);
		assert.ok(server.methods().includes("server.reload_config"));
		const note = stub.notes[0]!;
		assert.equal(note.type, "info");
		assert.match(note.text, /Herdr sidebar on/);
		assert.match(note.text, /settings\.json/);
		assert.match(note.text, new RegExp(`added the \\$mon agent row to ${configPath}`));
		assert.match(note.text, /Backup: .*config\.toml\.pi-monitor-.*\.bak/);
		assert.match(note.text, /Herdr reloaded its config/);

		await h.call("monitor", { description: "dev", command: "sleep 5" });
		const isDev = (r: { params: Record<string, unknown> }) => (r.params.tokens as { mon?: string })?.mon === "◐ dev";
		await until(() => server.received.some(isDev));
		const report = server.received.find(isDev)!;
		assert.equal(report.params.source, "pi-monitor");
		assert.equal(report.params.pane_id, "w1:p1");
		assert.deepEqual(report.params.tokens, { mon: "◐ dev" });
		assert.equal(server.methods().includes("workspace.report_metadata"), false, "per pane only, never the space");

		stub.notes.length = 0;
		await command("herdr");
		assert.match(stub.notes[0]!.text, /already has the monitor row\./);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("takes out the $ci space row an earlier version added and says so", async () => {
		const { h, server, stub, configPath, command } = await setup();
		writeFileSync(
			configPath,
			'[ui.sidebar.spaces]\n# pi-monitor: monitor rows\nrows = [\n  ["state_icon", "workspace"],\n  ["branch", "git_status"],\n  [{ token = "$ci" }],\n]\n',
		);
		await h.fire("session_start", { reason: "startup" });
		await command("herdr");
		assert.doesNotMatch(readFileSync(configPath, "utf8"), /\$ci|ui\.sidebar\.spaces/);
		assert.match(stub.notes.at(-1)!.text, /Removed the old \$ci row from the space rows/);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("puts the old config back when Herdr does not accept the change", async () => {
		const { h, server, stub, configPath, command } = await setup({
			reply: (r) =>
				r.method === "server.reload_config"
					? { result: { type: "config_reload", status: "applied", diagnostics: [{ message: "bad rule" }] } }
					: { result: { type: "ok" } },
		});
		writeFileSync(configPath, '[theme]\nname = "catppuccin"\n');
		await h.fire("session_start", { reason: "startup" });
		await command("herdr");
		assert.equal(readFileSync(configPath, "utf8"), '[theme]\nname = "catppuccin"\n');
		assert.equal(stub.notes.at(-1)!.type, "warning");
		assert.match(stub.notes.at(-1)!.text, /did not accept.*bad rule.*old config is back/);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("off: stores the choice, clears the tokens and keeps the config rows", async () => {
		const { h, server, stub, configPath, settingsFile, command } = await setup({ herdr: "on" });
		await h.fire("session_start", { reason: "startup" });
		await command("herdr");
		await h.call("monitor", { description: "dev", command: "sleep 5" });
		await until(() => server.received.some((r) => (r.params.tokens as { mon?: string })?.mon === "◐ dev"));
		stub.notes.length = 0;
		await command("herdr off");
		assert.equal(settingsFile().monitor.herdr, "off");
		assert.deepEqual(server.received.filter((r) => r.method.endsWith("report_metadata")).at(-1)!.params.tokens, {
			mon: null,
		});
		assert.match(readFileSync(configPath, "utf8"), /\$mon/);
		assert.match(stub.notes[0]!.text, /Herdr sidebar off/);
		assert.match(stub.notes[0]!.text, /delete that row below the "# pi-monitor" comment/);
		const reports = server.received.length;
		await h.call("monitor", { description: "dev 2", command: "sleep 5" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(server.received.length, reports, "nothing goes to Herdr while off");
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("reports a broken settings file instead of throwing", async () => {
		const { h, server, stub, command } = await setup();
		mkdirSync(join(h.home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(h.home, ".pi", "agent", "settings.json"), "{ broken");
		await command("herdr off");
		assert.equal(stub.notes.at(-1)!.type, "error");
		assert.match(stub.notes.at(-1)!.text, /not valid JSON/);
		await server.close();
	});

	it("status says where pi runs and what is set up", async () => {
		const { h, server, stub, command } = await setup({ herdr: "on" });
		await h.fire("session_start", { reason: "startup" });
		await command("herdr status");
		assert.match(stub.notes[0]!.text, /pane w1:p1/);
		assert.match(stub.notes[0]!.text, /Sidebar: on, sending/);
		await command("herdr nonsense");
		assert.equal(stub.notes[1]!.type, "error");
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});
});

describe("Herdr notifications", () => {
	it("sends Herdr toasts instead of the terminal notification: done for success, request for failure", async () => {
		const { h, server, desktop } = await setup({ herdr: "on" });
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "good", command: "true" });
		await h.call("monitor", { description: "broken", command: "exit 3" });
		await until(() => server.received.filter((r) => r.method === "notification.show").length === 2);
		const shown = server.received.filter((r) => r.method === "notification.show").map((r) => r.params);
		const ok = shown.find((p) => String(p.title).includes("good"))!;
		const broken = shown.find((p) => String(p.title).includes("broken"))!;
		assert.equal(ok.sound, "done");
		assert.match(String(ok.title), /^✓ good exited 0/);
		assert.equal(broken.sound, "request");
		assert.match(String(broken.title), /^✗ broken exited with code 3/);
		assert.deepEqual(desktop, [], "no second notification through the terminal");
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});

	it("falls back to the terminal notification when Herdr cannot be reached", async () => {
		const { h, server, desktop } = await setup({ herdr: "on" });
		await server.close();
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "ok", command: "true" });
		await until(() => desktop.length === 1);
		assert.match(desktop[0]!, /✓ ok/);
		await h.fire("session_shutdown", { reason: "quit" });
	});

	it("respects desktopNotifications: false", async () => {
		const { h, server, desktop } = await setup({ herdr: "on", desktopNotifications: false });
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "ok", command: "true" });
		await until(() => h.sent.some((s) => s.message.details.kind === "final"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(server.methods().includes("notification.show"), false);
		assert.deepEqual(desktop, []);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});
});

describe("Herdr blocked mark wiring", () => {
	it("marks the pane when a failure waits for someone and takes it back when the user types", async () => {
		const { h, server, internals } = await setup({ herdr: "on", attention: true });
		await h.fire("session_start", { reason: "startup" });
		// wake "never": the model does not pick this one up.
		await h.call("monitor", { description: "nightly", command: "exit 1", wake: "never" });
		await until(() => internals().registry.running().length === 0);
		await until(() => h.emitted.length === 1, GRACE_MS + 2_000);
		assert.deepEqual(h.emitted[0], { channel: BLOCKED_EVENT, data: { active: true, label: "nightly failed" } });
		await h.fire("input", { text: "what happened?", source: "interactive" });
		assert.deepEqual(h.emitted[1], { channel: BLOCKED_EVENT, data: { active: false } });
		await h.fire("session_shutdown", { reason: "quit" });
		assert.equal(h.emitted.length, 2, "nothing left to take back");
		await server.close();
	});

	it("does nothing unless herdrAttention is on", async () => {
		const { h, server, internals } = await setup({ herdr: "on" });
		await h.fire("session_start", { reason: "startup" });
		await h.call("monitor", { description: "nightly", command: "exit 1", wake: "never" });
		await until(() => internals().registry.running().length === 0);
		internals().herdr.ended(internals().registry.list()[0]!);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(h.emitted, []);
		await h.fire("session_shutdown", { reason: "quit" });
		await server.close();
	});
});
