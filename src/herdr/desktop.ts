import { execFile } from "node:child_process";
import { detectHerdr, FIRST_BACKOFF_MS, MAX_BACKOFF_MS } from "./client.ts";
import type { TokenSender } from "./sidebar.ts";

/** Where pi runs inside the Herdr desktop app: its herdr-core terminal, from `HC_TERMINAL_ID`. */
export interface DesktopTarget {
	terminal: string;
}

/**
 * The desktop app's terminal pi runs in, or undefined outside it. The Herdr TUI wins when both apply:
 * a Herdr TUI that runs inside the desktop app sets its own `HERDR_*` variables for pi.
 */
export function detectHerdrDesktop(env: NodeJS.ProcessEnv): DesktopTarget | undefined {
	const terminal = env.HC_TERMINAL_ID?.trim();
	if (!terminal || detectHerdr(env)) return undefined;
	return { terminal };
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a program and never throws: a program that cannot start resolves with code -1 and the reason. */
export type Run = (command: string, args: string[]) => Promise<RunResult>;

/** `herdr-app check` loads a mod and may take a few seconds. */
const RUN_TIMEOUT_MS = 10_000;

export const defaultRun: Run = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
			resolve({ code, stdout: stdout ?? "", stderr: stderr || (error && code === -1 ? error.message : "") || "" });
		});
	});

/** Label prefix on pi's terminal. A token `mon` becomes the label `pi-monitor.mon`. */
export const LABEL_PREFIX = "pi-monitor.";
/** Epoch ms after which the desktop mod ignores the labels, like Herdr's TTL: a crashed pi does not leave them up. */
export const UNTIL_LABEL = `${LABEL_PREFIX}until`;

/**
 * `hc label` arguments for a token patch. A null token removes its label. `until` is set while anything shows
 * and removed with the last token, so a pi with nothing to show leaves no labels behind.
 */
export function labelArgs(
	terminal: string,
	tokens: Record<string, string | null>,
	until: number | undefined,
	showing: boolean,
): string[] {
	const pairs = Object.entries(tokens).map(([key, value]) => `${LABEL_PREFIX}${key}=${value ?? ""}`);
	if (until !== undefined) pairs.push(`${UNTIL_LABEL}=${until}`);
	else if (!showing) pairs.push(`${UNTIL_LABEL}=`);
	return ["label", terminal, ...pairs];
}

export interface LabelsOptions {
	terminal: string;
	run: Run;
	log(message: string): void;
	now(): number;
	hc?: string;
}

/**
 * Publishes sidebar tokens as `hc label`s on pi's own terminal. Never throws. After a failed `hc` call it skips
 * calls for a growing while, like the TUI client, so a missing `hc` does not start a process every second.
 */
export class DesktopLabels {
	private readonly options: LabelsOptions;
	private readonly shown = new Map<string, string>();
	private failures = 0;
	private retryAt = 0;

	constructor(options: LabelsOptions) {
		this.options = options;
	}

	get backingOff(): boolean {
		return this.failures > 0 && this.options.now() < this.retryAt;
	}

	readonly send: TokenSender = async (tokens, ttlMs) => {
		if (this.backingOff) return false;
		const next = new Map(this.shown);
		for (const [key, value] of Object.entries(tokens)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		const until = ttlMs !== undefined ? this.options.now() + ttlMs : undefined;
		const args = labelArgs(this.options.terminal, tokens, until, next.size > 0);
		const result = await this.options.run(this.options.hc ?? "hc", args);
		if (result.code !== 0) {
			this.failures++;
			const wait = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (this.failures - 1));
			this.retryAt = this.options.now() + wait;
			const reason = (result.stderr || result.stdout).trim().split("\n")[0];
			this.options.log(`herdr desktop: hc label failed (${reason}), next try in ${wait / 1000}s`);
			return false;
		}
		if (this.failures > 0) this.options.log(`herdr desktop: hc works again after ${this.failures} failed calls`);
		this.failures = 0;
		this.shown.clear();
		for (const [key, value] of next) this.shown.set(key, value);
		return true;
	};
}
