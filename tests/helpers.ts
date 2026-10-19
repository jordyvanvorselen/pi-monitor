import type { Clock } from "../src/delivery.ts";

/** Deterministic clock. `advance` runs due timers in order. */
export class FakeClock implements Clock {
	private time: number;
	private seq = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();

	constructor(start = 1_700_000_000_000) {
		this.time = start;
	}

	now(): number {
		return this.time;
	}

	setTimeout(fn: () => void, ms: number): unknown {
		const id = ++this.seq;
		this.timers.set(id, { at: this.time + ms, fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.time = Math.max(this.time, due[1].at);
			due[1].fn();
		}
		this.time = end;
	}

	pending(): number {
		return this.timers.size;
	}
}

/** Theme stub that makes colors visible in snapshots: `<success>✓</success>`. */
export const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
};

/** Theme stub without any styling, for width checks. */
export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

export function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (check()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
			setTimeout(tick, 10);
		};
		tick();
	});
}
