import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Settings {
	/** Monitors that may run at the same time. */
	maxConcurrent: number;
	defaultTimeoutMinutes: number;
	/** Pin a classifier for the bash interceptor, as `provider/id`. Default: the first available one. */
	classifier?: string;
	/** The safety net moves an unsure bash command to the background after this many seconds. */
	backgroundAfterSeconds: number;
	/** OSC 9/99/777 desktop notification when a monitor ends. */
	desktopNotifications: boolean;
	/** No spinner and no flash. Clocks still tick once a second. */
	reducedMotion: boolean;
	/** Shortcut that opens and closes `/monitors`. */
	shortcut: string;
	/** Show monitors in the Herdr sidebar. Unset means the user has not decided yet. */
	herdr?: "on" | "off";
	/** Mark the pi pane as blocked in Herdr when a monitor fails and pi is not handling it. */
	herdrAttention: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	maxConcurrent: 5,
	defaultTimeoutMinutes: 30,
	backgroundAfterSeconds: 30,
	desktopNotifications: true,
	reducedMotion: false,
	shortcut: "ctrl+shift+m",
	herdrAttention: false,
};

export const MAX_TIMEOUT_MINUTES = 240;

function readMonitorSection(path: string): Record<string, unknown> {
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as { monitor?: unknown };
		return json.monitor && typeof json.monitor === "object" ? (json.monitor as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function pick<K extends keyof Settings>(raw: Record<string, unknown>, key: K, ok: (v: unknown) => boolean) {
	return ok(raw[key]) ? { [key]: raw[key] as Settings[K] } : {};
}

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const bool = (v: unknown) => typeof v === "boolean";

function validate(raw: Record<string, unknown>): Partial<Settings> {
	return {
		...pick(raw, "maxConcurrent", positive),
		...pick(raw, "defaultTimeoutMinutes", positive),
		...pick(raw, "classifier", (v) => typeof v === "string" && v.includes("/")),
		...pick(raw, "backgroundAfterSeconds", positive),
		...pick(raw, "desktopNotifications", bool),
		...pick(raw, "reducedMotion", bool),
		...pick(raw, "shortcut", (v) => typeof v === "string" && v.length > 0),
		...pick(raw, "herdr", (v) => v === "on" || v === "off"),
		...pick(raw, "herdrAttention", bool),
	};
}

/**
 * Read the `"monitor"` section of `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`.
 * Project settings win. Unknown keys and bad values are ignored.
 */
export function loadSettings(cwd: string, home = homedir()): Settings {
	const user = validate(readMonitorSection(userSettingsPath(home)));
	const project = validate(readMonitorSection(join(cwd, ".pi", "settings.json")));
	const merged = { ...DEFAULT_SETTINGS, ...user, ...project };
	merged.defaultTimeoutMinutes = Math.min(merged.defaultTimeoutMinutes, MAX_TIMEOUT_MINUTES);
	return merged;
}

export function userSettingsPath(home = homedir()): string {
	return join(home, ".pi", "agent", "settings.json");
}

/** Pi's settings lock is a `<file>.lock` directory (proper-lockfile). Older than this, it is stale. */
const LOCK_STALE_MS = 10_000;

function withLock<T>(path: string, fn: () => T): T {
	const lock = `${path}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
			} catch {
				// released meanwhile
			}
			if (stale) rmSync(lock, { recursive: true, force: true });
			else if (attempt >= 50) throw new Error(`${path} is locked`, { cause: error });
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
		return fn();
	} finally {
		try {
			rmdirSync(lock);
		} catch {
			// already gone
		}
	}
}

/**
 * Set one key in the `"monitor"` section of the user settings file and keep everything else.
 * Takes Pi's lock, re-reads the file and replaces it atomically. Throws when the file is not valid JSON.
 */
export function saveUserSetting<K extends keyof Settings>(key: K, value: Settings[K], home = homedir()): string {
	const path = userSettingsPath(home);
	mkdirSync(dirname(path), { recursive: true });
	withLock(path, () => {
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error(`${path} is not valid JSON`, { cause: error });
		}
		const section = json.monitor && typeof json.monitor === "object" ? (json.monitor as Record<string, unknown>) : {};
		json.monitor = { ...section, [key]: value };
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(json, null, 2)}\n`);
		renameSync(temp, path);
	});
	return path;
}
