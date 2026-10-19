import type { Clock, Delivery, Target, WakeLevel } from "./delivery.ts";
import { realClock } from "./delivery.ts";
import { abortableSleep } from "./exec.ts";
import { formatDuration } from "./format.ts";
import { MonitorLog } from "./log.ts";
import { savedTokens } from "./savings.ts";
import type { MonitorEvent, Outcome, OutcomeStatus, Progress, Run, Source, SourceKind } from "./sources/types.ts";

/** What the model asked for. Persisted, so gh watchers can restart after a resume. */
export interface MonitorSpec {
	description: string;
	kind: SourceKind;
	/** Command, run id/URL/"latest", PR, path, URL or pid. */
	target: string;
	match?: string;
	wake: WakeLevel;
	timeoutMinutes: number;
	/** Working directory. Defaults to the session cwd. */
	cwd?: string;
}

/** `ended` = a command watcher that did not survive a session restart. */
export type MonitorStatus = "running" | OutcomeStatus | "ended";

export interface ActivityBucket {
	bucket: number;
	count: number;
}

export const ACTIVITY_BUCKET_MS = 10_000;
const ACTIVITY_KEEP = 24;
const KEEP_FINISHED = 20;

export interface MonitorRecord extends Target {
	spec: MonitorSpec;
	kind: SourceKind;
	label: string;
	status: MonitorStatus;
	paused: boolean;
	startedAt: number;
	endedAt?: number;
	summary?: string;
	progress: Progress;
	lastLine?: string;
	lastLineAt?: number;
	activity: ActivityBucket[];
	/** The model is handling an event from this monitor. */
	handling: boolean;
	deliveredTokens: number;
	log: MonitorLog;
	controller: AbortController;
}

export type MonitorEntry =
	| { kind: "start"; id: string; spec: MonitorSpec; startedAt: number }
	| { kind: "resolve"; id: string; target: string }
	| { kind: "end"; id: string; status: MonitorStatus; summary: string; endedAt: number };

export interface RegistryDeps {
	delivery: Delivery;
	buildSource(spec: MonitorSpec): Source;
	openLog(id: string): MonitorLog;
	run: Run;
	cwd(): string;
	maxConcurrent(): number;
	persist(entry: MonitorEntry): void;
	/** Something changed that the UI should show. */
	onChange(): void;
	onEnd?(record: MonitorRecord): void;
	clock?: Clock;
}

export class MonitorLimitError extends Error {}

export class Registry {
	readonly monitors = new Map<string, MonitorRecord>();
	private nextId = 1;
	private readonly clock: Clock;
	private readonly deps: RegistryDeps;

	constructor(deps: RegistryDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? realClock;
	}

	running(): MonitorRecord[] {
		return [...this.monitors.values()].filter((m) => m.status === "running");
	}

	list(): MonitorRecord[] {
		return [...this.monitors.values()];
	}

	get(id: string): MonitorRecord | undefined {
		return this.monitors.get(id);
	}

	/** Make sure new ids do not collide with ids from the session history. */
	reserveId(id: string): void {
		const n = Number(id.replace(/^m/, ""));
		if (Number.isInteger(n) && n >= this.nextId) this.nextId = n + 1;
	}

	start(spec: MonitorSpec, restore?: { id: string; startedAt: number }): MonitorRecord {
		if (this.running().length >= this.deps.maxConcurrent())
			throw new MonitorLimitError(
				`Too many monitors (${this.deps.maxConcurrent()} running). Stop one with monitor_stop first.`,
			);
		const source = this.deps.buildSource(spec);
		const id = restore?.id ?? `m${this.nextId++}`;
		this.reserveId(id);
		const now = this.clock.now();
		const log = this.deps.openLog(id);
		const record: MonitorRecord = {
			id,
			description: spec.description,
			wake: spec.wake,
			logPath: log.path,
			spec,
			kind: spec.kind,
			label: source.label,
			status: "running",
			paused: false,
			startedAt: restore?.startedAt ?? now,
			progress: {},
			activity: [],
			handling: false,
			deliveredTokens: 0,
			log,
			controller: new AbortController(),
		};
		this.monitors.set(id, record);
		this.trimFinished();
		if (!restore) this.deps.persist({ kind: "start", id, spec, startedAt: record.startedAt });
		log.append(`# ${spec.description} (${source.label}) started ${new Date(now).toISOString()}`);
		void this.drive(record, source);
		this.deps.onChange();
		return record;
	}

	stop(id: string): boolean {
		const record = this.monitors.get(id);
		if (!record || record.status !== "running") return false;
		record.controller.abort();
		return true;
	}

	/** Abort every running monitor. Safe to call more than once. */
	stopAll(): number {
		let count = 0;
		for (const record of this.running()) if (this.stop(record.id)) count++;
		return count;
	}

	/** Show a monitor from the session history that cannot run anymore. */
	addEnded(spec: MonitorSpec, id: string, startedAt: number, summary: string): MonitorRecord {
		this.reserveId(id);
		const now = this.clock.now();
		const record: MonitorRecord = {
			id,
			description: spec.description,
			wake: spec.wake,
			logPath: "",
			spec,
			kind: spec.kind,
			label: spec.target,
			status: "ended",
			paused: false,
			startedAt,
			endedAt: now,
			summary,
			progress: {},
			activity: [],
			handling: false,
			deliveredTokens: 0,
			log: new MonitorLog(""),
			controller: new AbortController(),
		};
		this.monitors.set(id, record);
		this.deps.persist({ kind: "end", id, status: "ended", summary, endedAt: now });
		this.deps.onChange();
		return record;
	}

	setHandling(id: string, handling: boolean): void {
		const record = this.monitors.get(id);
		if (!record || record.handling === handling) return;
		record.handling = handling;
		this.deps.onChange();
	}

	clearHandling(): void {
		let changed = false;
		for (const record of this.monitors.values()) {
			if (record.handling) changed = true;
			record.handling = false;
		}
		if (changed) this.deps.onChange();
	}

	markPaused(id: string): void {
		const record = this.monitors.get(id);
		if (!record) return;
		record.paused = true;
		record.log.append("# paused: too noisy, events no longer wake the model");
		this.deps.onChange();
	}

	addDelivered(id: string, tokens: number): void {
		const record = this.monitors.get(id);
		if (record) record.deliveredTokens += tokens;
	}

	/** Estimated tokens saved versus a polling loop, over all monitors that would have woken the model. */
	savedTokens(now = this.clock.now()): number {
		let total = 0;
		for (const record of this.monitors.values()) {
			if (record.wake === "never" || record.status === "ended") continue;
			total += savedTokens((record.endedAt ?? now) - record.startedAt, record.deliveredTokens);
		}
		return total;
	}

	private trimFinished(): void {
		const finished = this.list().filter((m) => m.status !== "running");
		for (const record of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)))
			this.monitors.delete(record.id);
	}

	private touch(record: MonitorRecord, line?: string): void {
		const now = this.clock.now();
		const bucket = Math.floor(now / ACTIVITY_BUCKET_MS);
		const last = record.activity[record.activity.length - 1];
		if (last && last.bucket === bucket) last.count++;
		else record.activity.push({ bucket, count: 1 });
		if (record.activity.length > ACTIVITY_KEEP) record.activity.splice(0, record.activity.length - ACTIVITY_KEEP);
		if (line !== undefined) {
			record.lastLine = line;
			record.lastLineAt = now;
		}
	}

	private async drive(record: MonitorRecord, source: Source): Promise<void> {
		const { spec } = record;
		const signal = record.controller.signal;
		let matcher: RegExp | undefined;
		try {
			matcher = spec.match ? new RegExp(spec.match) : undefined;
		} catch {
			matcher = undefined;
		}
		const emit = (event: MonitorEvent) => {
			if (signal.aborted) return;
			record.log.append(`» ${event.text}`);
			for (const line of event.detail ?? []) record.log.append(`  ${line}`);
			this.touch(record, event.text);
			this.deps.delivery.event(record, event);
			this.deps.onChange();
		};
		const elapsedLimit = spec.timeoutMinutes * 60_000 - (this.clock.now() - record.startedAt);
		let timedOut = false;
		const timer = this.clock.setTimeout(
			() => {
				timedOut = true;
				record.controller.abort();
			},
			Math.max(60_000, elapsedLimit),
		);

		let outcome: Outcome;
		try {
			outcome = await source.start({
				signal,
				cwd: spec.cwd ?? this.deps.cwd(),
				run: this.deps.run,
				now: () => this.clock.now(),
				sleep: (ms) => abortableSleep(ms, signal),
				emit,
				line: (text, stream = "stdout") => {
					if (signal.aborted) return;
					record.log.append(stream === "stderr" ? `[stderr] ${text}` : text);
					this.touch(record, text);
					const passes = matcher ? matcher.test(text) : stream === "stdout";
					if (passes) this.deps.delivery.event(record, { text, level: "notable" });
					this.deps.onChange();
				},
				update: (progress) => {
					const latest = spec.kind === "gh_run" && spec.target === "latest";
					if (
						latest &&
						progress.url &&
						progress.url !== record.progress.url &&
						/\/actions\/runs\/\d+/.test(progress.url)
					)
						this.deps.persist({ kind: "resolve", id: record.id, target: progress.url });
					record.progress = { ...record.progress, ...progress };
					this.deps.onChange();
				},
			});
		} catch (error) {
			outcome = { status: "failure", summary: `monitor error: ${(error as Error).message}` };
		}
		this.clock.clearTimeout(timer);
		if (signal.aborted && outcome.status !== "success" && outcome.status !== "failure") {
			outcome = timedOut
				? { status: "timeout", summary: `no result after ${formatDuration(this.clock.now() - record.startedAt)}` }
				: { status: "stopped", summary: outcome.summary || "stopped" };
		}
		this.finish(record, outcome);
	}

	private finish(record: MonitorRecord, outcome: Outcome): void {
		if (record.status !== "running") return;
		record.status = outcome.status;
		record.summary = outcome.summary;
		record.endedAt = this.clock.now();
		record.handling = false;
		record.log.append(`# ${outcome.status}: ${outcome.summary}`);
		for (const line of outcome.detail ?? []) record.log.append(`  ${line}`);
		record.log.flush();
		this.deps.delivery.final(record, outcome);
		this.deps.persist({
			kind: "end",
			id: record.id,
			status: outcome.status,
			summary: outcome.summary,
			endedAt: record.endedAt,
		});
		this.deps.onEnd?.(record);
		this.deps.onChange();
	}
}

export function startedText(id: string, description: string, label: string, wake: WakeLevel): string {
	const then =
		wake === "final"
			? "You will be notified when it ends."
			: wake === "events"
				? "You will be notified of new events."
				: "It shows in the UI only.";
	return `Started ${id} "${description}" (${label}). ${then} Continue with other work.`;
}

export interface Started {
	id: string;
	/** Model-facing confirmation, e.g. `Started m3 "CI for PR #42" (gh run 123456). …`. */
	text: string;
	record: MonitorRecord;
}

/**
 * Start a monitor from code. The `monitor` tool uses this, and so can other modules
 * (for example a bash interceptor that turns a blocking wait into a monitor).
 * Throws `MonitorLimitError` or a source error with a message meant for the model.
 */
export function startMonitor(registry: Registry, spec: MonitorSpec): Started {
	const record = registry.start(spec);
	return { id: record.id, text: startedText(record.id, record.description, record.label, record.wake), record };
}
