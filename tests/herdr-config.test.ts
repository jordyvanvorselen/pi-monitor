import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "smol-toml";
import {
	DEFAULT_PALETTE,
	ManualSetupError,
	manualSnippet,
	mergeHerdrConfig,
	setupHerdrConfig,
} from "../src/herdr/config.ts";

const USER_CONFIG = `onboarding = false

[keys]
prefix = "ctrl+space"
# Jump to space 1-9
switch_workspace = "prefix+shift+1..9"

[ui]
status_indicators = "dots"

[theme]
name = "catppuccin"
`;

/** What 0.3.0 previews wrote: agent rows plus a $ci space row. */
const OLD_SETUP = `${USER_CONFIG}
[ui.sidebar.agents]
# pi-monitor: monitor rows, added by /monitors herdr. Remove the $mon and $ci rows to undo.
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$mon", rules = [{ starts_with = "✗", fg = "#FF5F6D" }, { starts_with = "◔", fg = "#FF5F6D" }, { starts_with = "✓", fg = "#3CF2C8" }, { starts_with = "◐", fg = "#FFD66B" }, { starts_with = "⏳", fg = "#FFD66B" }, { starts_with = "‖", fg = "#FFD66B" }] }],
]

[ui.sidebar.spaces]
# pi-monitor: monitor rows, added by /monitors herdr. Remove the $mon and $ci rows to undo.
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$ci", rules = [{ starts_with = "✗", fg = "#FF5F6D" }, { starts_with = "◔", fg = "#FF5F6D" }, { starts_with = "✓", fg = "#3CF2C8" }, { starts_with = "◐", fg = "#FFD66B" }] }],
]
`;

type Row = (string | { token: string })[];
const rows = (text: string, ...path: string[]) => {
	let node: unknown = parse(text);
	for (const part of path) node = (node as Record<string, unknown> | undefined)?.[part];
	return node as Row[];
};
const tokens = (list: Row[]) => list.map((row) => row.map((e) => (typeof e === "string" ? e : e.token)));

describe("Herdr config merge", () => {
	it("adds a $mon agent row below Herdr's default rows, leaves the space rows alone and keeps the rest of the file", () => {
		const { text, changed, toast } = mergeHerdrConfig(USER_CONFIG);
		assert.equal(changed, true);
		assert.ok(text.startsWith(USER_CONFIG.trimEnd()), "existing lines stay as they were, comments included");
		assert.deepEqual(tokens(rows(text, "ui", "sidebar", "agents", "rows")), [
			["state_icon", "machine", "workspace", "tab"],
			["agent"],
			["$mon"],
		]);
		assert.equal(rows(text, "ui", "sidebar", "spaces", "rows"), undefined, "monitors show per pane only");
		assert.equal(toast, "on");
		assert.equal((parse(text) as { ui: { toast?: unknown } }).ui.toast, undefined, "Herdr shows toasts by default");
	});

	it("colours the tokens by their first glyph: red failures, green successes, gold running", () => {
		const { text } = mergeHerdrConfig("");
		const mon = rows(text, "ui", "sidebar", "agents", "rows").at(-1)![0] as unknown as {
			rules: { starts_with: string; fg: string }[];
		};
		const colour = Object.fromEntries(mon.rules.map((r) => [r.starts_with, r.fg]));
		assert.equal(colour["✗"], DEFAULT_PALETTE.failed);
		assert.equal(colour["✓"], DEFAULT_PALETTE.ok);
		assert.equal(colour["◐"], DEFAULT_PALETTE.running);
		assert.ok(mon.rules.length <= 16, "Herdr allows 16 rules");
	});

	it("keeps the user's own rows and appends to them", () => {
		const custom = `[ui.sidebar.agents]
row_gap = 1
# my layout
rows = [
  ["state_icon", "agent", "state_text"],
  [{ token = "workspace", fg = "#89b4fa" }, "tab"],
]

[ui.sidebar.spaces]
rows = [["workspace"], ["branch"]]
`;
		const { text } = mergeHerdrConfig(custom);
		assert.deepEqual(tokens(rows(text, "ui", "sidebar", "agents", "rows")), [
			["state_icon", "agent", "state_text"],
			["workspace", "tab"],
			["$mon"],
		]);
		assert.deepEqual(
			{ ...(rows(text, "ui", "sidebar", "agents", "rows")[1]![0] as object) },
			{ token: "workspace", fg: "#89b4fa" },
		);
		assert.ok(text.includes('[ui.sidebar.spaces]\nrows = [["workspace"], ["branch"]]\n'), "space rows untouched");
		assert.match(text, /row_gap = 1\n# my layout\n# pi-monitor/);
		assert.equal((text.match(/\[ui\.sidebar\.agents\]/g) ?? []).length, 1, "no second table");
	});

	it("uses the pi override when the user has one in rows_by_agent", () => {
		const custom = `[ui.sidebar.agents.rows_by_agent]\npi = [["agent"], ["terminal_title_stripped"]]\n`;
		const { text } = mergeHerdrConfig(custom);
		assert.deepEqual(tokens(rows(text, "ui", "sidebar", "agents", "rows_by_agent", "pi")), [
			["agent"],
			["terminal_title_stripped"],
			["$mon"],
		]);
		assert.equal(rows(text, "ui", "sidebar", "agents", "rows"), undefined);
	});

	it("is idempotent: running it again changes nothing and does not add rows twice", () => {
		const once = mergeHerdrConfig(USER_CONFIG).text;
		const twice = mergeHerdrConfig(once);
		assert.equal(twice.changed, false);
		assert.equal(twice.text, once);
		assert.equal((once.match(/token = "\$mon"/g) ?? []).length, 1);
	});

	it("replaces its own rows when the colours change instead of adding new ones", () => {
		const once = mergeHerdrConfig(USER_CONFIG).text;
		const recoloured = mergeHerdrConfig(once, { ok: "#00FF00", failed: "#FF0000", running: "#FFFF00" }).text;
		assert.equal((recoloured.match(/token = "\$mon"/g) ?? []).length, 1);
		assert.match(recoloured, /#00FF00/);
		assert.equal(mergeHerdrConfig(once, { ok: "#00FF00", failed: "#FF0000", running: "#FFFF00" }).updated, true);
		assert.equal(mergeHerdrConfig(USER_CONFIG).updated, false);
		assert.doesNotMatch(recoloured, /#3CF2C8/);
	});

	it("leaves the toast delivery alone and reports when the user turned toasts off", () => {
		for (const delivery of ["off", "terminal"]) {
			const { text, toast } = mergeHerdrConfig(`[ui.toast]\ndelivery = "${delivery}"\n`);
			assert.equal(toast, delivery === "off" ? "off" : "on");
			assert.match(text, new RegExp(`delivery = "${delivery}"`));
			assert.equal((text.match(/delivery =/g) ?? []).length, 1);
		}
	});

	it("adds the row inside an existing table that has none yet", () => {
		const { text } = mergeHerdrConfig(
			`[ui.sidebar.agents]\nrow_gap = 1\n\n[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\n`,
		);
		const doc = parse(text) as {
			ui: { sidebar: { agents: { row_gap: number; rows: unknown[]; rows_by_agent: { claude: unknown[] } } } };
		};
		assert.equal(doc.ui.sidebar.agents.row_gap, 1);
		assert.equal(doc.ui.sidebar.agents.rows.length, 3);
		assert.equal(doc.ui.sidebar.agents.rows_by_agent.claude.length, 1);
		assert.equal((text.match(/\[ui\.sidebar\.agents\]/g) ?? []).length, 1);
	});

	it("removes the $ci space block an earlier version added, leaving the file as if it was never there", () => {
		const { text, removedSpaceRow } = mergeHerdrConfig(OLD_SETUP);
		assert.equal(removedSpaceRow, true);
		assert.equal(text, mergeHerdrConfig(USER_CONFIG).text);
		assert.doesNotMatch(text, /\$ci|ui\.sidebar\.spaces/);
		assert.equal(mergeHerdrConfig(text).changed, false, "idempotent afterwards");
	});

	it("removes the old space block also when another table follows it", () => {
		const { text } = mergeHerdrConfig(`${OLD_SETUP}\n[remote]\nx = 1\n`);
		assert.doesNotMatch(text, /\$ci|ui\.sidebar\.spaces/);
		assert.match(text, /\]\n\n\[remote\]\nx = 1\n$/);
	});

	it("takes only the $ci row out of the user's own space rows", () => {
		const own = `[ui.sidebar.spaces]
row_gap = 1
# pi-monitor: monitor rows, added by /monitors herdr. Remove the $mon and $ci rows to undo.
rows = [
  ["workspace"],
  [{ token = "$ci", rules = [{ starts_with = "✗", fg = "#FF5F6D" }] }],
]
`;
		const { text } = mergeHerdrConfig(own);
		assert.match(text, /\[ui\.sidebar\.spaces\]\nrow_gap = 1\nrows = \[\n {2}\["workspace"\],\n\]\n/);
		assert.doesNotMatch(text, /\$ci/);
	});

	it("keeps the space table when it holds other settings", () => {
		const own = `[ui.sidebar.spaces]
row_gap = 1
# pi-monitor: monitor rows, added by /monitors herdr. Remove the $mon and $ci rows to undo.
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$ci" }],
]
`;
		const { text } = mergeHerdrConfig(own);
		assert.match(text, /^\[ui\.sidebar\.spaces\]\nrow_gap = 1\n/);
		assert.equal(
			(parse(text) as { ui: { sidebar: { spaces: { rows?: unknown } } } }).ui.sidebar.spaces.rows,
			undefined,
		);
	});

	it("refuses configs it cannot edit safely and offers the lines to add by hand", () => {
		assert.throws(() => mergeHerdrConfig('[ui]\nsidebar.agents.rows = [["agent"]]\n'), ManualSetupError);
		assert.throws(() => mergeHerdrConfig("this is = = not toml"), ManualSetupError);
		assert.match(manualSnippet(), /\$mon/);
		assert.ok(parse(manualSnippet()));
	});

	const herdrBin = spawnSync("herdr", ["--version"]).status === 0;
	it("writes a config that Herdr itself accepts", { skip: !herdrBin && "herdr is not installed" }, () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-monitor-herdr-check-"));
		const path = join(dir, "config.toml");
		writeFileSync(path, mergeHerdrConfig(USER_CONFIG).text);
		const check = spawnSync("herdr", ["config", "check"], {
			env: { ...process.env, HERDR_CONFIG_PATH: path },
			encoding: "utf8",
		});
		assert.match(`${check.stdout}${check.stderr}`, /config: ok/);
	});
});

describe("Herdr config file", () => {
	const setup = (content?: string) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-monitor-herdr-config-"));
		const path = join(dir, "herdr", "config.toml");
		if (content !== undefined) {
			setupHerdrConfig(path, { validate: () => undefined }); // creates the directory
			writeFileSync(path, content);
		}
		return { dir: join(dir, "herdr"), path };
	};
	const backups = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".bak"));

	it("backs the old file up before changing it", () => {
		const { dir, path } = setup(USER_CONFIG);
		const result = setupHerdrConfig(path, { now: new Date(2026, 9, 24, 11, 33, 20) });
		assert.equal(result.backup, `${path}.pi-monitor-20261024-113320.bak`);
		assert.equal(readFileSync(result.backup!, "utf8"), USER_CONFIG);
		assert.match(readFileSync(path, "utf8"), /\$mon/);
		assert.deepEqual(backups(dir), ["config.toml.pi-monitor-20261024-113320.bak"]);
	});

	it("does not write or back up anything when the rows are already there", () => {
		const { dir, path } = setup(USER_CONFIG);
		setupHerdrConfig(path, { now: new Date(2026, 0, 1) });
		const again = setupHerdrConfig(path, { now: new Date(2026, 0, 2) });
		assert.equal(again.changed, false);
		assert.equal(backups(dir).length, 1);
	});

	it("creates the file when there is none", () => {
		const { path } = setup();
		const result = setupHerdrConfig(path);
		assert.equal(result.created, true);
		assert.equal(result.backup, undefined);
		assert.ok(existsSync(path));
	});

	it("leaves the file untouched when Herdr says the new text is invalid", () => {
		const { dir, path } = setup(USER_CONFIG);
		assert.throws(() => setupHerdrConfig(path, { validate: () => "unknown field" }), /would not accept.*unknown field/);
		assert.equal(readFileSync(path, "utf8"), USER_CONFIG);
		assert.deepEqual(backups(dir), []);
		assert.deepEqual(readdirSync(dir), ["config.toml"], "the candidate file is gone");
	});
});
