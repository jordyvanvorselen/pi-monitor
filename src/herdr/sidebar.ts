import type { Clock } from "../delivery.ts";
import { isVisible, type DockItem } from "../ui/dock.ts";
import type { HerdrReply } from "./client.ts";
import { PANE_TOKEN, paneToken, SPACE_TOKEN, spaceToken } from "./tokens.ts";

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
	workspaceId?: string;
	items(): readonly DockItem[];
	clock: Clock;
}

type Value = string | null;

/**
 * Keeps the `$mon` pane token and the `$ci` workspace token in Herdr up to date.
 * Sends only when a value changes, at most once a second, refreshes the TTL while a value shows,
 * and clears values with null when nothing is left.
 */
export class HerdrSidebar {
	private readonly deps: SidebarDeps;
	/** What Herdr has. Undefined: not known yet, so the first tick sends even a null. */
	private sent: { pane?: Value; space?: Value } = {};
	private sentAt = { pane: 0, space: 0 };
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
		const tokens: Promise<unknown>[] = [];
		if (this.sent.pane !== null) tokens.push(this.report("pane", null));
		if (this.deps.workspaceId && this.sent.space !== null) tokens.push(this.report("space", null));
		await Promise.all(tokens);
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
		const wanted = { pane: paneToken(items, now), space: this.deps.workspaceId ? spaceToken(items, now) : null };
		const due = (key: "pane" | "space") =>
			wanted[key] !== this.sent[key] || (wanted[key] !== null && now - this.sentAt[key] >= REFRESH_MS);
		const sends: Promise<unknown>[] = [];
		if (due("pane")) sends.push(this.report("pane", wanted.pane));
		if (this.deps.workspaceId && due("space")) sends.push(this.report("space", wanted.space));
		if (sends.length) {
			this.lastSendAt = now;
			this.busy = true;
			await Promise.all(sends);
			this.busy = false;
		}
		// Keep ticking while something shows: clocks move, finished rows expire, the TTL needs a refresh.
		const live = items.some((i) => isVisible(i, now));
		if (!this.stopped && (live || this.sent.pane || this.sent.space)) this.schedule(MIN_INTERVAL_MS);
	}

	private async report(key: "pane" | "space", value: Value): Promise<void> {
		const name = key === "pane" ? PANE_TOKEN : SPACE_TOKEN;
		const target = key === "pane" ? { pane_id: this.deps.paneId } : { workspace_id: this.deps.workspaceId };
		const method = key === "pane" ? "pane.report_metadata" : "workspace.report_metadata";
		const reply = await this.deps.request(method, {
			...target,
			source: SOURCE,
			tokens: { [name]: value },
			...(value === null ? {} : { ttl_ms: TTL_MS }),
		});
		// Not reached: try again on the next tick. Refused (logged by the client): do not repeat it every second.
		if (!reply) return;
		this.sent[key] = value;
		this.sentAt[key] = this.deps.clock.now();
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
