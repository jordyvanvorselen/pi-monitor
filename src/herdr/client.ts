import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where pi runs inside Herdr, from the variables Herdr sets in every pane. */
export interface HerdrTarget {
	socketPath: string;
	paneId: string;
	workspaceId?: string;
}

/** The Herdr pane pi runs in, or undefined outside Herdr. */
export function detectHerdr(env: NodeJS.ProcessEnv): HerdrTarget | undefined {
	if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return undefined;
	return {
		socketPath: env.HERDR_SOCKET_PATH,
		paneId: env.HERDR_PANE_ID,
		...(env.HERDR_WORKSPACE_ID ? { workspaceId: env.HERDR_WORKSPACE_ID } : {}),
	};
}

/** Herdr's config file: `HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`. */
export function herdrConfigPath(env: NodeJS.ProcessEnv, home = homedir()): string {
	if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "config.toml");
}

export interface HerdrReply {
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

export interface HerdrClientOptions {
	socketPath: string;
	log(message: string): void;
	now?(): number;
	/** A request without a reply after this long counts as failed. */
	timeoutMs?: number;
}

/** First wait after a failed request. Doubles per failure up to `MAX_BACKOFF_MS`. */
export const FIRST_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * Talks to Herdr's socket: one JSON line out, one JSON line back, a new connection per request.
 * Requests run one after the other, so updates arrive in order. Never throws: a failed request
 * resolves to undefined, is logged, and makes the client skip requests for a growing while.
 */
export class HerdrClient {
	private readonly options: HerdrClientOptions;
	private chain: Promise<unknown> = Promise.resolve();
	private failures = 0;
	private retryAt = 0;
	private counter = 0;

	constructor(options: HerdrClientOptions) {
		this.options = options;
	}

	/** True while the client skips requests after failures. */
	get backingOff(): boolean {
		return this.failures > 0 && this.now() < this.retryAt;
	}

	/** Send a request. Resolves to the reply, or undefined when Herdr could not be reached. */
	request(method: string, params: Record<string, unknown>): Promise<HerdrReply | undefined> {
		const next = this.chain.then(() => this.send(method, params));
		this.chain = next.catch(() => {});
		return next;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private async send(method: string, params: Record<string, unknown>): Promise<HerdrReply | undefined> {
		if (this.backingOff) return undefined;
		const id = `pi-monitor:${process.pid}:${++this.counter}`;
		try {
			const reply = await this.exchange(JSON.stringify({ id, method, params }));
			if (this.failures > 0) this.options.log(`herdr: reachable again after ${this.failures} failed requests`);
			this.failures = 0;
			if (reply.error)
				this.options.log(`herdr: ${method} refused: ${reply.error.code ?? ""} ${reply.error.message ?? ""}`);
			return reply;
		} catch (error) {
			this.failures++;
			const wait = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (this.failures - 1));
			this.retryAt = this.now() + wait;
			this.options.log(`herdr: ${method} failed (${(error as Error).message}), next try in ${wait / 1000}s`);
			return undefined;
		}
	}

	private exchange(line: string): Promise<HerdrReply> {
		return new Promise((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const socket = createConnection(this.options.socketPath);
			const finish = (error: Error | undefined, reply?: HerdrReply) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve(reply!);
			};
			const timer = setTimeout(() => finish(new Error("no reply")), this.options.timeoutMs ?? 1_000);
			timer.unref?.();
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${line}\n`));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				try {
					finish(undefined, JSON.parse(buffer.slice(0, end)) as HerdrReply);
				} catch {
					finish(new Error("bad reply"));
				}
			});
			socket.on("error", (error) => finish(error));
			socket.on("end", () => finish(new Error("closed without reply")));
		});
	}
}
