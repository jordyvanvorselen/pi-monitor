import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DockMode = "card" | "line" | "hidden";

export interface Settings {
	/** Monitors that may run at the same time. */
	maxConcurrent: number;
	defaultTimeoutMinutes: number;
	/** Block `gh run watch`, `gh pr checks --watch` and long `sleep` calls in bash. */
	blockBlockingWaits: boolean;
	/** OSC 9/99/777 desktop notification when a monitor ends. */
	desktopNotifications: boolean;
	/** No spinner and no flash. Clocks still tick once a second. */
	reducedMotion: boolean;
	/** How the dock starts. The shortcut cycles card → line → hidden. */
	dock: DockMode;
	/** Shortcut that cycles the dock mode. */
	shortcut: string;
}

export const DEFAULT_SETTINGS: Settings = {
	maxConcurrent: 5,
	defaultTimeoutMinutes: 30,
	blockBlockingWaits: true,
	desktopNotifications: true,
	reducedMotion: false,
	dock: "card",
	shortcut: "ctrl+shift+m",
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
		...pick(raw, "blockBlockingWaits", bool),
		...pick(raw, "desktopNotifications", bool),
		...pick(raw, "reducedMotion", bool),
		...pick(raw, "dock", (v) => v === "card" || v === "line" || v === "hidden"),
		...pick(raw, "shortcut", (v) => typeof v === "string" && v.length > 0),
	};
}

/**
 * Read the `"monitor"` section of `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`.
 * Project settings win. Unknown keys and bad values are ignored.
 */
export function loadSettings(cwd: string, home = homedir()): Settings {
	const user = validate(readMonitorSection(join(home, ".pi", "agent", "settings.json")));
	const project = validate(readMonitorSection(join(cwd, ".pi", "settings.json")));
	const merged = { ...DEFAULT_SETTINGS, ...user, ...project };
	merged.defaultTimeoutMinutes = Math.min(merged.defaultTimeoutMinutes, MAX_TIMEOUT_MINUTES);
	return merged;
}
