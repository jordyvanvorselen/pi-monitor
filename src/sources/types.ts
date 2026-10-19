export type EventLevel = "progress" | "notable" | "failure";

/** Something the source wants to report. `detail` holds extra lines, e.g. the tail of a failed log. */
export interface MonitorEvent {
	text: string;
	level: EventLevel;
	/** Sub-heading for the model message, e.g. `job "test" step "Run unit tests" failed:`. */
	context?: string;
	detail?: string[];
	/** Lines left out of `detail`. */
	dropped?: number;
}

export type OutcomeStatus = "success" | "failure" | "timeout" | "stopped";

export interface Outcome {
	status: OutcomeStatus;
	/** One short line, e.g. `CI #42 green in 6m02s`. */
	summary: string;
	context?: string;
	detail?: string[];
	dropped?: number;
}

export type JobState = "queued" | "running" | "success" | "failure" | "skipped";

export interface Job {
	name: string;
	state: JobState;
	id?: number;
	startedAt?: number;
	completedAt?: number;
	/** Step that runs now, or the step that failed. */
	step?: string;
	url?: string;
}

/** UI-only progress. Never sent to the model. */
export interface Progress {
	/** Short label for UI, e.g. `CI #42`. */
	title?: string;
	url?: string;
	jobs?: Job[];
	/** Typical duration of a successful run, from history. */
	etaMs?: number;
	/** When the watched thing started, if it started before the monitor. */
	startedAt?: number;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Runs a program without a shell. Tests replace it so `gh` never runs in CI. */
export type Run = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; cwd?: string },
) => Promise<RunResult>;

export interface SourceContext {
	signal: AbortSignal;
	cwd: string;
	run: Run;
	/** When the monitor started (earlier than now after a resume). */
	startedAt: number;
	now(): number;
	/** Resolves after `ms`, or early when the monitor stops. */
	sleep(ms: number): Promise<void>;
	/** Structured event. The pipeline decides whether it wakes the model. */
	emit(event: MonitorEvent): void;
	/** Raw output line. Goes to the log and the UI; `match` turns it into an event. */
	line(text: string, stream?: "stdout" | "stderr"): void;
	/** UI progress update. */
	update(progress: Partial<Progress>): void;
}

export type SourceKind = "command" | "gh_run" | "gh_pr" | "file" | "url" | "pid";

export interface Source {
	kind: SourceKind;
	/** What is watched, for UI and the start message, e.g. `gh run 123456`. */
	label: string;
	start(ctx: SourceContext): Promise<Outcome>;
}
