import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import { GLYPHS, PANE_TOKEN, SPACE_TOKEN } from "./tokens.ts";

/** Rule colours, as `#RRGGBB`. */
export interface HerdrPalette {
	ok: string;
	failed: string;
	running: string;
}

/** The launch video palette: teal, red and gold. */
export const DEFAULT_PALETTE: HerdrPalette = { ok: "#3CF2C8", failed: "#FF5F6D", running: "#FFD66B" };

/** Herdr's built-in layouts, used when the config has none. */
export const DEFAULT_AGENT_ROWS: Rows = [["state_icon", "machine", "workspace", "tab"], ["agent"]];
export const DEFAULT_SPACE_ROWS: Rows = [
	["state_icon", "workspace"],
	["branch", "git_status"],
];

/** Every line pi-monitor writes has this comment right above it. */
export const MARKER = "# pi-monitor";
const ROWS_COMMENT = `${MARKER}: monitor rows, added by /monitors herdr. Remove the $${PANE_TOKEN} and $${SPACE_TOKEN} rows to undo.`;

type Entry = string | { token: string; [key: string]: unknown };
type Rows = Entry[][];

/** Thrown when the config cannot be changed automatically. The message says what to add by hand. */
export class ManualSetupError extends Error {}

function rules(palette: HerdrPalette) {
	return [
		{ starts_with: GLYPHS.failure, fg: palette.failed },
		{ starts_with: GLYPHS.timeout, fg: palette.failed },
		{ starts_with: GLYPHS.success, fg: palette.ok },
		{ starts_with: GLYPHS.running, fg: palette.running },
		{ starts_with: GLYPHS.probation, fg: palette.running },
		{ starts_with: GLYPHS.paused, fg: palette.running },
	];
}

export function monitorRow(palette: HerdrPalette): Entry[] {
	return [{ token: `$${PANE_TOKEN}`, rules: rules(palette) }];
}

export function ciRow(palette: HerdrPalette): Entry[] {
	return [{ token: `$${SPACE_TOKEN}`, rules: rules(palette).slice(0, 4) }];
}

const tokenOf = (entry: unknown) =>
	typeof entry === "string" ? entry : ((entry as { token?: unknown } | null)?.token as string | undefined);

/** The rows without `token`, and without rows that become empty. */
function without(rows: Rows, token: string): Rows {
	return rows.map((row) => row.filter((entry) => tokenOf(entry) !== token)).filter((row) => row.length > 0);
}

/** TOML for a value from a parsed config or from us: strings, numbers, booleans, arrays and inline tables. */
export function tomlValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	if (value && typeof value === "object") {
		const fields = Object.entries(value).map(
			([key, v]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(v)}`,
		);
		return fields.length ? `{ ${fields.join(", ")} }` : "{}";
	}
	throw new ManualSetupError(`cannot write ${String(value)} back to TOML`);
}

function rowsValue(rows: Rows): string {
	return `[\n${rows.map((row) => `  ${tomlValue(row)},`).join("\n")}\n]`;
}

interface Statement {
	kind: "table" | "arrayTable" | "key";
	path: string[];
	/** First and last line, inclusive. */
	start: number;
	end: number;
}

function splitKey(raw: string): string[] {
	return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

function parses(text: string): boolean {
	try {
		parse(text);
		return true;
	} catch {
		return false;
	}
}

/** Table headers and key/value statements with their line ranges. Multi-line values end where the snippet parses. */
function scan(lines: readonly string[]): Statement[] {
	const statements: Statement[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line || line.startsWith("#")) continue;
		const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
		if (header) {
			const kind = header[1] === "[[" ? "arrayTable" : "table";
			statements.push({ kind, path: splitKey(header[2]!), start: i, end: i });
			continue;
		}
		const key = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\- ])+?)\s*=/.exec(line);
		if (!key) throw new ManualSetupError(`cannot read line ${i + 1}`);
		let end = i;
		while (end < lines.length && !parses(lines.slice(i, end + 1).join("\n"))) end++;
		if (end >= lines.length) throw new ManualSetupError(`cannot read the value on line ${i + 1}`);
		statements.push({ kind: "key", path: splitKey(key[1]!), start: i, end });
		i = end;
	}
	return statements;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Set `key` in `[table]` to `value` (TOML text). Replaces the old value, adds the key, or appends the table. */
function setKey(text: string, table: string[], key: string, value: string, comment: string): string {
	const lines = text.split("\n");
	const statements = scan(lines);
	const assignment = [comment, ...`${key} = ${value}`.split("\n")];
	const headerIndex = statements.findIndex((s) => s.kind === "table" && same(s.path, table));
	if (headerIndex < 0) {
		while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
		const gap = lines.length ? [""] : [];
		return [...lines, ...gap, `[${table.join(".")}]`, ...assignment, ""].join("\n");
	}
	const header = statements[headerIndex]!;
	const nextHeader = statements.find((s, i) => i > headerIndex && s.kind !== "key");
	const sectionEnd = nextHeader ? nextHeader.start : lines.length;
	const existing = statements.find(
		(s) => s.kind === "key" && s.start > header.start && s.start < sectionEnd && same(s.path, [key]),
	);
	if (!existing) {
		lines.splice(header.end + 1, 0, ...assignment);
		return lines.join("\n");
	}
	const hasComment = existing.start > 0 && lines[existing.start - 1]!.trim().startsWith(MARKER);
	const from = hasComment ? existing.start - 1 : existing.start;
	lines.splice(from, existing.end - from + 1, ...assignment);
	return lines.join("\n");
}

function lookup(doc: unknown, path: readonly string[]): unknown {
	let node = doc;
	for (const part of path) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

/** What `/monitors herdr` adds, for people who edit the file themselves. */
export function manualSnippet(palette: HerdrPalette = DEFAULT_PALETTE): string {
	return [
		"[ui.sidebar.agents]",
		`rows = ${rowsValue([...DEFAULT_AGENT_ROWS, monitorRow(palette)])}`,
		"",
		"[ui.sidebar.spaces]",
		`rows = ${rowsValue([...DEFAULT_SPACE_ROWS, ciRow(palette)])}`,
	].join("\n");
}

export interface MergeResult {
	text: string;
	changed: boolean;
	/** The config already had our rows; this run only refreshed them (new colours). */
	updated: boolean;
	/** Herdr toasts: `off` when the user turned them off (`[ui.toast] delivery = "off"`). We leave that choice alone. */
	toast: "on" | "off";
}

/**
 * Add the monitor rows to Herdr's config text. Keeps the user's rows (or Herdr's defaults when there are none)
 * and appends a `$mon` row to the agent rows and a `$ci` row to the space rows. Agent rows go to
 * `rows_by_agent.pi` when the user has one for pi.
 * Running it again gives the same text. Everything else in the file stays as it is.
 */
export function mergeHerdrConfig(text: string, palette: HerdrPalette = DEFAULT_PALETTE): MergeResult {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (error) {
		throw new ManualSetupError(`it is not valid TOML: ${(error as Error).message.split("\n")[0]}`);
	}
	const piRows = lookup(doc, ["ui", "sidebar", "agents", "rows_by_agent", "pi"]);
	const agentTable = Array.isArray(piRows)
		? { table: ["ui", "sidebar", "agents", "rows_by_agent"], key: "pi", rows: piRows as Rows }
		: {
				table: ["ui", "sidebar", "agents"],
				key: "rows",
				rows: (lookup(doc, ["ui", "sidebar", "agents", "rows"]) as Rows | undefined) ?? DEFAULT_AGENT_ROWS,
			};
	const spaceRows = (lookup(doc, ["ui", "sidebar", "spaces", "rows"]) as Rows | undefined) ?? DEFAULT_SPACE_ROWS;
	const wanted = {
		agents: [...without(agentTable.rows, `$${PANE_TOKEN}`), monitorRow(palette)],
		spaces: [...without(spaceRows, `$${SPACE_TOKEN}`), ciRow(palette)],
	};

	let next = setKey(text, agentTable.table, agentTable.key, rowsValue(wanted.agents), ROWS_COMMENT);
	next = setKey(next, ["ui", "sidebar", "spaces"], "rows", rowsValue(wanted.spaces), ROWS_COMMENT);

	// Check the result says what we meant. Dotted keys or inline tables we do not edit would make it differ.
	let check: unknown;
	try {
		check = parse(next);
	} catch {
		throw new ManualSetupError("its tables are written in a way pi-monitor does not edit");
	}
	const ok =
		JSON.stringify(lookup(check, [...agentTable.table, agentTable.key])) === JSON.stringify(wanted.agents) &&
		JSON.stringify(lookup(check, ["ui", "sidebar", "spaces", "rows"])) === JSON.stringify(wanted.spaces);
	if (!ok) throw new ManualSetupError("its tables are written in a way pi-monitor does not edit");

	return {
		text: next,
		changed: next !== text,
		updated: JSON.stringify(agentTable.rows).includes(`"$${PANE_TOKEN}"`),
		toast: lookup(doc, ["ui", "toast", "delivery"]) === "off" ? "off" : "on",
	};
}

export interface SetupResult extends MergeResult {
	path: string;
	/** Copy of the old file, when there was one and something changed. */
	backup?: string;
	created: boolean;
}

function stamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export interface SetupOptions {
	palette?: HerdrPalette;
	now?: Date;
	/** Ask Herdr whether a candidate file is valid. Returns its complaint, or undefined when it is fine. */
	validate?(candidatePath: string): string | undefined;
}

/**
 * Merge the monitor rows into the config file. Lets Herdr check the new text first, backs the old file up
 * and writes atomically. Throws `ManualSetupError` when it cannot, without touching the file.
 */
export function setupHerdrConfig(path: string, options: SetupOptions = {}): SetupResult {
	const { palette = DEFAULT_PALETTE, now = new Date() } = options;
	let text = "";
	let exists = true;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		exists = false;
	}
	const merged = mergeHerdrConfig(text, palette);
	if (!merged.changed) return { ...merged, path, created: false };
	mkdirSync(dirname(path), { recursive: true });
	if (options.validate) {
		// Next to the real file, so paths relative to the config directory still resolve.
		const candidate = `${path}.pi-monitor-check.toml`;
		writeFileSync(candidate, merged.text);
		let complaint: string | undefined;
		try {
			complaint = options.validate(candidate);
		} finally {
			rmSync(candidate, { force: true });
		}
		if (complaint) throw new ManualSetupError(`Herdr would not accept the change: ${complaint}`);
	}
	let backup: string | undefined;
	if (exists) {
		backup = `${path}.pi-monitor-${stamp(now)}.bak`;
		copyFileSync(path, backup);
	}
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, merged.text);
	renameSync(temp, path);
	return { ...merged, path, created: !exists, ...(backup ? { backup } : {}) };
}

/** Put the backup back, when Herdr refused the new config. */
export function restoreHerdrConfig(result: SetupResult): void {
	if (result.backup) copyFileSync(result.backup, result.path);
	else if (result.created) rmSync(result.path, { force: true });
}
