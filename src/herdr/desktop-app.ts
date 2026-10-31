import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GLYPHS } from "./tokens.ts";
import { LABEL_PREFIX, UNTIL_LABEL, type Run } from "./desktop.ts";

/** The shipped agents list the mod starts from. */
export const SHIPPED_AGENTS = "agents";
/** pi-monitor's clone of the shipped agents list, with monitor status under each agent. */
export const MOD_NAME = "pi-monitor-agents";
/** The first line of the patched mod. Marks the folder as pi-monitor's, so setup may replace it and off may delete it. */
export const MOD_MARKER = `// ${MOD_NAME}: made by pi-monitor`;
/** A layout clone that shows the mod is named after the layout it came from: `main-pi-monitor`. */
export const LAYOUT_SUFFIX = "-pi-monitor";

/** The desktop app's folder: `HERDR_APP_HOME`, else `~/.config/herdr-app`. */
export function herdrAppHome(env: NodeJS.ProcessEnv, home = homedir()): string {
	return env.HERDR_APP_HOME || join(home, ".config", "herdr-app");
}

/** The code the patch adds after the mod's imports. Self-contained: it imports what it uses under its own names. */
export function monitorRowCode(): string {
	const keys = ["mon", "mon_fail", "mon_run", "mon_wait", "mon_ok"];
	return `
import { terminals as piMonitorTerminals, theme as piMonitorTheme, layout as piMonitorLayout } from "herdr";
import { div as piMonitorDiv } from "gpui-kit";
import { h_flex as piMonitorHFlex, v_flex as piMonitorVFlex } from "gpui-base";

// pi-monitor publishes its monitors as labels on pi's terminal: ${LABEL_PREFIX}mon (the most important monitor),
// the counts ${LABEL_PREFIX}mon_fail, mon_run, mon_wait and mon_ok, and ${UNTIL_LABEL} (ms; stale after it).
const PI_MONITOR_KEYS = ${JSON.stringify(keys)};
function piMonitorParts(address) {
  const labels = piMonitorTerminals().find((k) => k.address === address)?.labels ?? {};
  if (!(Number(labels[${JSON.stringify(UNTIL_LABEL)}]) > Date.now())) return [];
  return PI_MONITOR_KEYS.map((key) => labels[${JSON.stringify(LABEL_PREFIX)} + key]).filter(Boolean);
}
// Coloured by the first glyph, like the Herdr TUI rules: failed, running, green, the rest dim.
function piMonitorColor(t, value) {
  const glyph = Array.from(value)[0];
  if (glyph === ${JSON.stringify(GLYPHS.failure)} || glyph === ${JSON.stringify(GLYPHS.timeout)}) return t.blocked;
  if (glyph === ${JSON.stringify(GLYPHS.running)}) return t.working;
  if (glyph === ${JSON.stringify(GLYPHS.success)}) return t.done;
  return t.muted;
}
function piMonitorFind(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = piMonitorFind(child, id);
    if (found) return found;
  }
  return null;
}
// A row with a line of monitor status under it. The narrow rail has no room for it.
function piMonitorRow(el, address, indent) {
  if (!address || (piMonitorFind(piMonitorLayout(), "sidebar")?.size?.px ?? Infinity) < 160) return el;
  const parts = piMonitorParts(address);
  if (!parts.length) return el;
  const t = piMonitorTheme();
  return piMonitorVFlex().flex_none().child(el).child(
    piMonitorHFlex().pl(indent).pr(8).pb(4).gap(6).min_w(0).items_center().text_size(11.5).children(
      parts.map((value, i) => piMonitorDiv().text_color(piMonitorColor(t, value))
        .when(i === 0, (d) => d.min_w(0).truncate())
        .when(i > 0, (d) => d.flex_none())
        .child(value))));
}
`;
}

/** Adds monitor status under every agent and sub-agent row of the shipped agents mod's `main.js`. */
export function patchAgentsMod(source: string): string {
	if (source.startsWith(MOD_MARKER)) return source;
	const imports = [...source.matchAll(/^import [^;]*;$/gm)];
	const last = imports.at(-1);
	if (!last) throw new Error("the agents mod has no imports where expected");
	const row = /const row = \(([^)]*)\) => \{/;
	const subRow = /^([ \t]*)subRow\(([^)]*)\) \{/m;
	if (!row.test(source) || !subRow.test(source))
		throw new Error("this version of the agents mod has no row and subRow where pi-monitor expects them");
	const end = last.index + last[0].length;
	const patched = `${source.slice(0, end)}\n${monitorRowCode()}${source.slice(end)}`
		.replace(
			row,
			// An agent row: 8 px padding, a 16 px icon and a 9 px gap before the name.
			(_m, params: string) =>
				`const row = (...args) => piMonitorRow(rowBase(...args), args[0]?.address, 33);\n    const rowBase = (${params}) => {`,
		)
		.replace(
			subRow,
			// A sub-agent row: 39 px padding, 13 px per tree line, then the 14 px icon and its margin.
			(_m, indent: string, params: string) =>
				`${indent}subRow(...args) {\n${indent}  const s = args[1];\n${indent}  return piMonitorRow(this.subRowBase(...args), s?.t?.address, 39 + 13 * (s?.lines?.length ?? 0) + 22);\n${indent}}\n\n${indent}subRowBase(${params}) {`,
		);
	return `${MOD_MARKER}. /monitors herdr off removes it.\n${patched}`;
}

type Node = {
	id?: string;
	content?: { mod?: string };
	children?: Node[];
	floating?: Node[];
	cloned_from?: { name?: string };
};

function blocks(node: Node | undefined): Node[] {
	if (!node || typeof node !== "object") return [];
	return [node, ...(node.children ?? []).flatMap(blocks), ...(node.floating ?? []).flatMap(blocks)];
}

/** True when a layout shows the mod somewhere. */
export function layoutUses(layout: unknown, mod: string): boolean {
	return blocks(layout as Node).some((n) => n.content?.mod === mod);
}

/** Points every block of mod `from` at mod `to`. Returns how many it changed. */
export function swapMod(layout: unknown, from: string, to: string): number {
	const hits = blocks(layout as Node).filter((n) => n.content?.mod === from);
	for (const n of hits) n.content!.mod = to;
	return hits.length;
}

export interface DesktopAppDeps {
	env: NodeJS.ProcessEnv;
	home: string;
	run: Run;
}

export interface DesktopState {
	/** The shown layout, or undefined when the app did not answer. */
	layout: string | undefined;
	/** The shown layout uses the mod. */
	showing: boolean;
	/** pi-monitor's mod folder exists. */
	installed: boolean;
}

/**
 * Installs and removes pi-monitor's agents list in the Herdr desktop app. Shipped mods and layouts are read-only,
 * so setup clones the shipped `agents` mod, adds the monitor line, clones the shown layout and points the clone's
 * agents block at the new mod. Off switches back and deletes both clones. Never touches files it did not make.
 */
export class DesktopApp {
	private readonly deps: DesktopAppDeps;

	constructor(deps: DesktopAppDeps) {
		this.deps = deps;
	}

	get folder(): string {
		return herdrAppHome(this.deps.env, this.deps.home);
	}

	get modFolder(): string {
		return join(this.folder, "mods", MOD_NAME);
	}

	private layoutFile(name: string): string {
		return join(this.folder, "layouts", `${name}.json`);
	}

	private readLayout(name: string): Node | undefined {
		try {
			return JSON.parse(readFileSync(this.layoutFile(name), "utf8")) as Node;
		} catch {
			return undefined;
		}
	}

	private ours(name: string): boolean {
		return name.endsWith(LAYOUT_SUFFIX) && layoutUses(this.readLayout(name), MOD_NAME);
	}

	private modIsOurs(): boolean {
		try {
			return readFileSync(join(this.modFolder, "main.js"), "utf8").startsWith(MOD_MARKER);
		} catch {
			return false;
		}
	}

	private async app(args: string[]): Promise<string> {
		const result = await this.deps.run(this.deps.env.HERDR_APP_BIN || "herdr-app", args);
		const output = `${result.stdout}${result.stderr}`.trim();
		if (result.code !== 0) {
			let reason = output.split("\n").slice(0, 4).join(" ");
			try {
				reason = (JSON.parse(output) as { error?: string }).error ?? reason;
			} catch {
				// not JSON: keep the text
			}
			throw new Error(`herdr-app ${args.slice(0, 2).join(" ")} failed: ${reason || `exit ${result.code}`}`);
		}
		return result.stdout;
	}

	private do(command: string, args: Record<string, unknown>): Promise<string> {
		return this.app(["do", command, JSON.stringify(args)]);
	}

	/** The shown layout's name. Throws when the app does not answer. */
	private async shownLayout(): Promise<string> {
		const status = JSON.parse(await this.app(["status"])) as { layout?: string };
		if (!status.layout) throw new Error("herdr-app status names no layout");
		return status.layout;
	}

	async state(): Promise<DesktopState> {
		let layout: string | undefined;
		try {
			layout = await this.shownLayout();
		} catch {
			layout = undefined;
		}
		return {
			layout,
			showing: layout !== undefined && layoutUses(this.readLayout(layout), MOD_NAME),
			installed: existsSync(this.modFolder),
		};
	}

	/** Install or refresh the mod and show it. Resolves to what it did, one line each. */
	async setup(): Promise<string[]> {
		const lines: string[] = [];
		const shown = await this.shownLayout();
		await this.installMod();
		lines.push(`Herdr app: installed the ${MOD_NAME} mod (Herdr's agents list with a monitor line under each pi).`);
		if (layoutUses(this.readLayout(shown), MOD_NAME)) {
			lines.push(`Layout ${shown} already shows it.`);
			return lines;
		}
		if (!layoutUses(this.readLayout(shown), SHIPPED_AGENTS)) {
			lines.push(
				`Layout ${shown} has no agents list. Switch to one that has (ctrl-shift-l) and run /monitors herdr again.`,
			);
			return lines;
		}
		const name = `${shown}${LAYOUT_SUFFIX}`;
		if (existsSync(this.layoutFile(name))) {
			if (!this.ours(name)) throw new Error(`layout ${name} already exists and is not pi-monitor's`);
			await this.do("layout.switch", { name });
			lines.push(`Switched to layout ${name}, which shows it.`);
			return lines;
		}
		// The clone keeps the shown layout's clicks (sizes, hidden panels) and becomes the shown one.
		await this.do("layout.clone", { name: shown, as: name });
		const layout = this.readLayout(name);
		if (!layout) throw new Error(`could not read the new layout ${name}`);
		swapMod(layout, SHIPPED_AGENTS, MOD_NAME);
		writeFileSync(this.layoutFile(name), `${JSON.stringify(layout, null, 2)}\n`);
		lines.push(`Layout: now ${name}, a copy of ${shown} with this agents list. ctrl-shift-l switches layouts.`);
		return lines;
	}

	/** A fresh clone of the shipped agents mod, patched and checked. */
	private async installMod(): Promise<void> {
		if (existsSync(this.modFolder)) {
			if (!this.modIsOurs()) throw new Error(`the mod folder ${this.modFolder} already exists and is not pi-monitor's`);
			// Again from the shipped one: it picks up a newer agents list after a Herdr update.
			rmSync(this.modFolder, { recursive: true, force: true });
		}
		await this.do("mod.clone", { name: SHIPPED_AGENTS, as: MOD_NAME });
		const main = join(this.modFolder, "main.js");
		try {
			writeFileSync(main, patchAgentsMod(readFileSync(main, "utf8")));
			await this.app(["check", this.modFolder]);
		} catch (error) {
			rmSync(this.modFolder, { recursive: true, force: true });
			throw error;
		}
	}

	/** Switch away from pi-monitor's layout and delete what setup made. Resolves to what it did. */
	async remove(): Promise<string[]> {
		const lines: string[] = [];
		const shown = await this.shownLayout();
		if (this.ours(shown)) {
			const from = this.readLayout(shown)?.cloned_from?.name;
			const back = from && existsSync(this.layoutFile(from)) ? from : "main";
			await this.do("layout.switch", { name: back });
			lines.push(`Herdr app: back to layout ${back}.`);
		}
		const layouts = existsSync(join(this.folder, "layouts")) ? readdirSync(join(this.folder, "layouts")) : [];
		for (const file of layouts.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))) {
			if (!this.ours(file)) continue;
			rmSync(this.layoutFile(file));
			lines.push(`Deleted layout ${file}.`);
		}
		const users = layouts.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
		const still = users.filter(
			(name) => existsSync(this.layoutFile(name)) && layoutUses(this.readLayout(name), MOD_NAME),
		);
		if (still.length) lines.push(`Kept the ${MOD_NAME} mod: layout ${still.join(", ")} still uses it.`);
		else if (this.modIsOurs()) {
			rmSync(this.modFolder, { recursive: true, force: true });
			lines.push(`Deleted the ${MOD_NAME} mod.`);
		}
		return lines;
	}
}
