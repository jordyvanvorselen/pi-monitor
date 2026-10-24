import type { Clock } from "../delivery.ts";
import { displayName, type DockItem } from "../ui/dock.ts";

/** Event the Herdr pi integration listens to. `active: true` marks the pane as blocked, `false` takes one mark back. */
export const BLOCKED_EVENT = "herdr:blocked";
/** A failure the model picks up within this time never marks the pane. */
export const GRACE_MS = 2_000;

export interface AttentionDeps {
	emit(channel: string, data: { active: boolean; label?: string }): void;
	/** The monitor as it is now, or undefined when it is gone. */
	get(id: string): (DockItem & { handling: boolean }) | undefined;
	clock: Clock;
}

/**
 * Marks the pi pane as blocked in Herdr while a failed monitor waits for someone.
 * Every `active: true` gets exactly one `active: false`, because the listener counts them.
 */
export class Attention {
	private readonly deps: AttentionDeps;
	/** Monitors that marked the pane, with the name they were shown under. */
	private readonly blocked = new Map<string, { name: string; description: string }>();
	private readonly pending = new Map<string, unknown>();

	constructor(deps: AttentionDeps) {
		this.deps = deps;
	}

	get count(): number {
		return this.blocked.size;
	}

	/** A monitor failed or timed out. Marks the pane unless the model takes it within the grace time. */
	failed(item: DockItem & { handling: boolean }): void {
		if (item.handling || this.blocked.has(item.id) || this.pending.has(item.id)) return;
		const handle = this.deps.clock.setTimeout(() => {
			this.pending.delete(item.id);
			const now = this.deps.get(item.id);
			if (!now || now.handling) return;
			const label = `${displayName(now)} ${now.status === "timeout" ? "timed out" : "failed"}`;
			this.blocked.set(item.id, { name: displayName(now), description: now.description });
			this.deps.emit(BLOCKED_EVENT, { active: true, label });
		}, GRACE_MS);
		(handle as { unref?: () => void }).unref?.();
		this.pending.set(item.id, handle);
	}

	/**
	 * Take marks back that no longer apply: the model handles the monitor, it is gone,
	 * or a new monitor with the same name started (a re-run).
	 */
	sync(running: readonly DockItem[]): void {
		for (const [id, { name, description }] of this.blocked) {
			const item = this.deps.get(id);
			const rerun = running.some(
				(r) =>
					r.id !== id &&
					r.status === "running" &&
					r.probationUntil === undefined &&
					(displayName(r) === name || r.description === description),
			);
			if (!item || item.handling || rerun) this.clear(id);
		}
	}

	/** Take every mark back, e.g. when the user types, at shutdown or when the integration turns off. */
	clearAll(): void {
		for (const handle of this.pending.values()) this.deps.clock.clearTimeout(handle);
		this.pending.clear();
		for (const id of [...this.blocked.keys()]) this.clear(id);
	}

	private clear(id: string): void {
		if (!this.blocked.delete(id)) return;
		this.deps.emit(BLOCKED_EVENT, { active: false });
	}
}
