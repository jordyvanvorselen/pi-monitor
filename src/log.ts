import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "./format.ts";

export const LOG_ROOT = join(tmpdir(), "pi-monitor");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TAIL = 200;

export function sessionLogDir(sessionId: string, root = LOG_ROOT): string {
	return join(root, sessionId.replace(/[^\w.-]/g, "_") || "session");
}

/** Full log on disk plus an in-memory tail for the overlay. */
export class MonitorLog {
	readonly tail: string[] = [];
	lineCount = 0;
	private pending: string[] = [];
	private timer: NodeJS.Timeout | undefined;

	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	append(line: string): void {
		const clean = stripAnsi(line);
		this.tail.push(clean);
		if (this.tail.length > TAIL) this.tail.splice(0, this.tail.length - TAIL);
		this.lineCount++;
		this.pending.push(clean);
		if (this.pending.length >= 500) this.flush();
		else if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), 200);
			this.timer.unref();
		}
	}

	/** Write buffered lines to disk. Called on a short timer and when the monitor ends. */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.pending.length === 0) return;
		const text = this.pending.join("\n") + "\n";
		this.pending = [];
		try {
			appendFileSync(this.path, text);
		} catch {
			// The log is best effort. A full disk must not break the monitor.
		}
	}

	static open(dir: string, id: string): MonitorLog {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// best effort
		}
		return new MonitorLog(join(dir, `${id}.log`));
	}
}

/** Remove session log directories older than seven days. */
export function cleanupOldLogs(root = LOG_ROOT, now = Date.now(), maxAgeMs = MAX_AGE_MS): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(root, name);
		try {
			if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
		} catch {
			// ignore races with other sessions
		}
	}
}
