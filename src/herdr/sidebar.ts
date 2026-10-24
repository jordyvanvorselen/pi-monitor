import type { Clock } from "../delivery.ts";
import { isVisible, type DockItem } from "../ui/dock.ts";
import type { HerdrReply } from "./client.ts";
import { sidebarTokens } from "./tokens.ts";

/** Fixed metadata source. Herdr keeps at most 32 sources per pane for its lifetime, so never vary it. */
export const SOURCE = "pi-monitor";
/** Herdr drops our tokens this long after the last report, e.g. when pi crashes. */
export const TTL_MS = 60_000;
/** Reports again before the TTL runs out while a token still shows. */
export const REFRESH_MS = 30_000;
/** At most one report per this interval: every token change resends the sidebar to SSH clients. */
export const MIN_INTERVAL_MS = 1_000;

export interface SidebarDeps {
	request(method: string, params: Record<string, unknown>): Promise<HerdrReply | undefined>;
	paneId: string;
	items(): readonly DockItem[];
	clock: Clock;
	/** The token values for these monitors. Default: `$mon` and the count tokens. */
	tokens?(items: readonly DockItem[], now: number): Record<string, string | null>;
}

type Tokens = Record<string, string | null>;

/**
 * Keeps pi-monitor's pane tokens in Herdr up to date: `$mon` and the count tokens. Only the pane:
 * two pi sessions in one space would overwrite each other's space token, because Herdr keeps the
 * last value per key. One report per tick carries every changed token. Sends only on change, at most
 * once a second, refreshes the TTL of every shown token, and clears tokens with null when they go.
 */
export class HerdrSidebar {
	private readonly deps: SidebarDeps;
	/** What Herdr has per token. A missing key: not known yet, so the first tick sends even a null. */
	private sent: Tokens = {};
	private sentAt = 0;
	private lastSendAt = Number.NEGATIVE_INFINITY;
	private timer: unknown;
	private busy = false;
	private stopped = false;

	constructor(deps: SidebarDeps) {
		this.deps = deps;
	}

	/** Monitors changed. Cheap: bursts of changes wait for the next tick. */
	update(): void {
		if (this.stopped || this.timer !== undefined) return;
		const wait = this.lastSendAt + MIN_INTERVAL_MS - this.deps.clock.now();
		if (wait <= 0) void this.tick();
		else this.schedule(wait);
	}

	/** Clear our tokens and stop. Resolves when Herdr answered (or did not). */
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancel();
		const keys = Object.keys(this.wanted());
		const clear = Object.fromEntries(keys.filter((k) => this.sent[k] !== null).map((k) => [k, null]));
		if (Object.keys(clear).length) await this.report(clear);
	}

	/** True while a timer is pending. */
	get ticking(): boolean {
		return this.timer !== undefined;
	}

	private wanted(): Tokens {
		const now = this.deps.clock.now();
		return (this.deps.tokens ?? sidebarTokens)(this.deps.items(), now);
	}

	private async tick(): Promise<void> {
		this.timer = undefined;
		if (this.stopped) return;
		if (this.busy) return this.schedule(MIN_INTERVAL_MS);
		const now = this.deps.clock.now();
		const items = this.deps.items();
		const wanted = this.wanted();
		const changed = Object.entries(wanted).filter(([key, value]) => this.sent[key] !== value);
		const shown = Object.entries(wanted).filter(([, value]) => value !== null);
		const refresh = shown.length > 0 && now - this.sentAt >= REFRESH_MS;
		if (changed.length || refresh) {
			// A refresh resends every shown token, because Herdr gives each token its own TTL.
			const patch = Object.fromEntries(refresh ? [...shown, ...changed] : changed);
			this.lastSendAt = now;
			this.busy = true;
			await this.report(patch);
			this.busy = false;
		}
		// Keep ticking while something shows: clocks move, finished rows expire, the TTL needs a refresh.
		const live = items.some((i) => isVisible(i, now));
		const showing = Object.values(this.sent).some((v) => v);
		if (!this.stopped && (live || showing)) this.schedule(MIN_INTERVAL_MS);
	}

	private async report(tokens: Tokens): Promise<void> {
		const anyValue = Object.values(tokens).some((v) => v !== null);
		const reply = await this.deps.request("pane.report_metadata", {
			pane_id: this.deps.paneId,
			source: SOURCE,
			tokens,
			...(anyValue ? { ttl_ms: TTL_MS } : {}),
		});
		// Not reached: try again on the next tick. Refused (logged by the client): do not repeat it every second.
		if (!reply) return;
		Object.assign(this.sent, tokens);
		if (anyValue) this.sentAt = this.deps.clock.now();
	}

	private schedule(ms: number): void {
		if (this.stopped || this.timer !== undefined) return;
		this.timer = this.deps.clock.setTimeout(() => void this.tick(), ms);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private cancel(): void {
		if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}
}
