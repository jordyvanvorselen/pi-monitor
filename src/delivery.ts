import { collapseRepeats, estimateTokens, formatEvent } from "./format.ts";
import type { EventLevel, MonitorEvent, Outcome, OutcomeStatus } from "./sources/types.ts";

export const CUSTOM_TYPE = "monitor";

export type WakeLevel = "final" | "events" | "never";

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The monitor fields delivery needs. */
export interface Target {
	id: string;
	description: string;
	wake: WakeLevel;
	logPath: string;
}

export interface MonitorMessageDetails {
	id: string;
	description: string;
	kind: "event" | "final" | "noisy";
	/** One line for the collapsed transcript view. */
	summary: string;
	level?: EventLevel;
	status?: OutcomeStatus;
}

export interface OutgoingMessage {
	customType: typeof CUSTOM_TYPE;
	content: string;
	display: boolean;
	details: MonitorMessageDetails;
}

export interface SendOptions {
	triggerTurn: true;
	deliverAs?: "steer" | "followUp";
}

export interface DeliveryDeps {
	send(message: OutgoingMessage, options: SendOptions): void;
	isIdle(): boolean;
	clock?: Clock;
	/** Called when the flood guard pauses a monitor. */
	onPause?(id: string): void;
	/** Called after a message went out, with its estimated token count. */
	onSent?(id: string, tokens: number): void;
}

export interface DeliveryLimits {
	batchMs: number;
	maxBatchLines: number;
	floodLimit: number;
	floodWindowMs: number;
	maxTokens: number;
}

export const DEFAULT_LIMITS: DeliveryLimits = {
	batchMs: 500,
	maxBatchLines: 20,
	floodLimit: 10,
	floodWindowMs: 60_000,
	maxTokens: 400,
};

interface Batch {
	target: Target;
	lines: string[];
	dropped: number;
	timer: unknown;
}

const STATUS_WORD: Record<OutcomeStatus, string> = {
	success: "done",
	failure: "failed",
	timeout: "timed out",
	stopped: "stopped",
};

/** Does an event at this level wake the model under this wake level? Failures always wake, except under `never`. */
export function wakes(wake: WakeLevel, level: EventLevel): boolean {
	if (wake === "never") return false;
	if (level === "failure") return true;
	return wake === "events" && level === "notable";
}

/**
 * Decides what reaches the model and how: batching, flood guard and the `sendMessage` options.
 * Idle → trigger a turn. Busy → follow-up. Failure while busy → steer.
 */
export class Delivery {
	private readonly clock: Clock;
	private readonly limits: DeliveryLimits;
	private readonly batches = new Map<string, Batch>();
	private readonly recentWakes = new Map<string, number[]>();
	private readonly paused = new Set<string>();

	private readonly deps: DeliveryDeps;

	constructor(deps: DeliveryDeps, limits: Partial<DeliveryLimits> = {}) {
		this.deps = deps;
		this.clock = deps.clock ?? realClock;
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	isPaused(id: string): boolean {
		return this.paused.has(id);
	}

	event(target: Target, event: MonitorEvent): void {
		if (!wakes(target.wake, event.level) || this.paused.has(target.id)) return;
		if (event.level === "failure") {
			this.flush(target.id);
			if (!this.admit(target)) return;
			const content = formatEvent(
				{
					id: target.id,
					description: target.description,
					headline: event.text,
					...(event.context ? { context: event.context } : {}),
					lines: event.detail ?? [],
					dropped: event.dropped ?? 0,
					logPath: target.logPath,
					alwaysLog: true,
				},
				this.limits.maxTokens,
			);
			this.send(target, content, { kind: "event", level: "failure", summary: event.text }, true);
			return;
		}
		let batch = this.batches.get(target.id);
		if (!batch) {
			batch = { target, lines: [], dropped: 0, timer: undefined };
			this.batches.set(target.id, batch);
		}
		for (const line of [event.text, ...(event.detail ?? []).map((d) => `  ${d}`)]) {
			if (batch.lines.length < this.limits.maxBatchLines) batch.lines.push(line);
			else batch.dropped++;
		}
		batch.timer ??= this.clock.setTimeout(() => this.flush(target.id), this.limits.batchMs);
	}

	/** Send the pending batch of a monitor now. */
	flush(id: string): void {
		const batch = this.batches.get(id);
		if (!batch) return;
		this.batches.delete(id);
		if (batch.timer !== undefined) this.clock.clearTimeout(batch.timer);
		if (batch.lines.length === 0 || !this.admit(batch.target)) return;
		const lines = collapseRepeats(batch.lines);
		const single = lines.length === 1 && batch.dropped === 0;
		const headline = single ? lines[0]! : `${batch.lines.length + batch.dropped} new lines`;
		const content = formatEvent(
			{
				id: batch.target.id,
				description: batch.target.description,
				headline,
				lines: single ? [] : lines,
				dropped: batch.dropped,
				logPath: batch.target.logPath,
			},
			this.limits.maxTokens,
		);
		this.send(batch.target, content, { kind: "event", level: "notable", summary: headline }, false);
	}

	/** The monitor ended. Stops and `never` monitors stay silent. */
	final(target: Target, outcome: Outcome): void {
		this.flush(target.id);
		this.forget(target.id);
		if (target.wake === "never" || outcome.status === "stopped") return;
		const content = formatEvent(
			{
				id: target.id,
				description: target.description,
				headline: `${STATUS_WORD[outcome.status]}: ${outcome.summary}`,
				...(outcome.context ? { context: outcome.context } : {}),
				lines: outcome.detail ?? [],
				dropped: outcome.dropped ?? 0,
				logPath: target.logPath,
				alwaysLog: outcome.status !== "success",
			},
			this.limits.maxTokens,
		);
		// The transcript shows the status as a glyph, so the summary leaves out the status word.
		const details = { kind: "final" as const, status: outcome.status, summary: outcome.summary };
		this.send(target, content, details, outcome.status === "failure");
	}

	/** Drop timers and flood state of a monitor. */
	forget(id: string): void {
		const batch = this.batches.get(id);
		if (batch?.timer !== undefined) this.clock.clearTimeout(batch.timer);
		this.batches.delete(id);
		this.recentWakes.delete(id);
		this.paused.delete(id);
	}

	dispose(): void {
		for (const id of [...this.batches.keys()]) this.forget(id);
	}

	/** Flood guard. Returns false when the monitor is (now) paused. */
	private admit(target: Target): boolean {
		if (this.paused.has(target.id)) return false;
		const now = this.clock.now();
		const recent = (this.recentWakes.get(target.id) ?? []).filter((t) => now - t < this.limits.floodWindowMs);
		if (recent.length >= this.limits.floodLimit) {
			this.paused.add(target.id);
			this.recentWakes.delete(target.id);
			this.deps.onPause?.(target.id);
			const text =
				`[monitor ${target.id} "${target.description}"] ${target.id} is too noisy. ` +
				"It keeps running, but its events no longer wake you. Tighten `match` or use `wake: final`. " +
				`Log: ${target.logPath}`;
			this.send(target, text, { kind: "noisy", summary: "too noisy, paused" }, false);
			return false;
		}
		recent.push(now);
		this.recentWakes.set(target.id, recent);
		return true;
	}

	private send(
		target: Target,
		content: string,
		details: Omit<MonitorMessageDetails, "id" | "description">,
		urgent: boolean,
	) {
		const options: SendOptions = this.deps.isIdle()
			? { triggerTurn: true }
			: { triggerTurn: true, deliverAs: urgent ? "steer" : "followUp" };
		this.deps.send(
			{
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details: { id: target.id, description: target.description, ...details },
			},
			options,
		);
		this.deps.onSent?.(target.id, estimateTokens(content));
	}
}
