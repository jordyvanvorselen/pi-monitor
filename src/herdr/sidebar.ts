import type { Clock } from "../delivery.ts";
import { isVisible, type DockItem } from "../ui/dock.ts";
import type { HerdrReply } from "./client.ts";
import { PANE_TOKEN, paneToken } from "./tokens.ts";

/** Fixed metadata source. Herdr keeps at most 32 sources per pane for its lifetime, so never vary it. */
export const SOURCE = "pi-monitor";
/** Herdr drops our token this long after the last report, e.g. when pi crashes. */
export const TTL_MS = 60_000;
/** Reports again before the TTL runs out while the token still shows. */
export const REFRESH_MS = 30_000;
/** At most one report per this interval: every token change resends the sidebar to SSH clients. */
export const MIN_INTERVAL_MS = 1_000;

export interface SidebarDeps {
	request(method: string, params: Record<string, unknown>): Promise<HerdrReply | undefined>;
	paneId: string;
	items(): readonly DockItem[];
	clock: Clock;
}

/**
 * Keeps the `$mon` pane token in Herdr up to date. Only the pane: two pi sessions in one space
 * would overwrite each other's space token, because Herdr keeps the last value per key.
 * Sends only when the value changes, at most once a second, refreshes the TTL while it shows,
 * and clears it with null when nothing is left.
 */
export class HerdrSidebar {
	private readonly deps: SidebarDeps;
	/** What Herdr has. Undefined: not known yet, so the first tick sends even a null. */
	private sent: string | null | undefined;
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

	/** Clear our token and stop. Resolves when Herdr answered (or did not). */
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancel();
		if (this.sent !== null) await this.report(null);
	}

	/** True while a timer is pending. */
	get ticking(): boolean {
		return this.timer !== undefined;
	}

	private async tick(): Promise<void> {
		this.timer = undefined;
		if (this.stopped) return;
		if (this.busy) return this.schedule(MIN_INTERVAL_MS);
		const now = this.deps.clock.now();
		const items = this.deps.items();
		const wanted = paneToken(items, now);
		const due = wanted !== this.sent || (wanted !== null && now - this.sentAt >= REFRESH_MS);
		if (due) {
			this.lastSendAt = now;
			this.busy = true;
			await this.report(wanted);
			this.busy = false;
		}
		// Keep ticking while something shows: clocks move, finished rows expire, the TTL needs a refresh.
		const live = items.some((i) => isVisible(i, now));
		if (!this.stopped && (live || this.sent)) this.schedule(MIN_INTERVAL_MS);
	}

	private async report(value: string | null): Promise<void> {
		const reply = await this.deps.request("pane.report_metadata", {
			pane_id: this.deps.paneId,
			source: SOURCE,
			tokens: { [PANE_TOKEN]: value },
			...(value === null ? {} : { ttl_ms: TTL_MS }),
		});
		// Not reached: try again on the next tick. Refused (logged by the client): do not repeat it every second.
		if (!reply) return;
		this.sent = value;
		this.sentAt = this.deps.clock.now();
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
