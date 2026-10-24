// Text helpers for model-facing event messages. Everything here is pure so it is easy to test.

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const GH_COMMAND = /^##\[(group|endgroup|section|command)\]/;

/** Approximate tokens for a string. Four characters per token is the usual rule of thumb. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/**
 * Clean one log line: ANSI codes, `gh --log-failed` prefixes (`job\tstep\ttimestamp`),
 * ISO timestamps and GitHub workflow commands. `##[error]` becomes `error: `.
 */
export function cleanLine(line: string): string {
	let text = stripAnsi(line).replace(/\r/g, "");
	const tabbed = text.split("\t");
	if (tabbed.length >= 3 && ISO_TIMESTAMP.test(tabbed.slice(2).join("\t"))) text = tabbed.slice(2).join("\t");
	text = text.replace(ISO_TIMESTAMP, "");
	text = text.replace(/^##\[error\]/, "error: ").replace(/^##\[warning\]/, "warning: ");
	text = text.replace(GH_COMMAND, "");
	return text.trimEnd();
}

/** Collapse runs of identical lines into one line with a count, e.g. `(×37) Waiting for job…`. */
export function collapseRepeats(lines: readonly string[]): string[] {
	const out: string[] = [];
	let previous: string | undefined;
	let count = 0;
	const flush = () => {
		if (previous === undefined) return;
		out.push(count > 1 ? `(×${count}) ${previous}` : previous);
	};
	for (const line of lines) {
		if (line === previous) {
			count++;
			continue;
		}
		flush();
		previous = line;
		count = 1;
	}
	flush();
	return out;
}

/** Keep the last `max` lines. Returns how many lines were dropped. */
export function tail(lines: readonly string[], max: number): { lines: string[]; dropped: number } {
	if (lines.length <= max) return { lines: [...lines], dropped: 0 };
	return { lines: lines.slice(lines.length - max), dropped: lines.length - max };
}

/** Clean, drop blank lines, collapse repeats and keep the tail of a log excerpt. */
export function excerpt(raw: readonly string[], max = 30): { lines: string[]; dropped: number } {
	const cleaned = collapseRepeats(raw.map(cleanLine).filter((line) => line.trim() !== ""));
	return tail(cleaned, max);
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

/** Short clock for narrow UI and the Herdr sidebar: `42s`, `4m`, `1h05m`. Hours read like `formatDuration`. */
export function formatShortDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	if (total < 3600) return `${Math.floor(total / 60)}m`;
	return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${Math.round(tokens)}`;
	if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

export interface EventMessage {
	id: string;
	description: string;
	/** First line after the `[monitor …]` tag, e.g. `FAILED after 6m12s`. */
	headline: string;
	/** Optional sub-heading, e.g. `job "test" step "Run unit tests" failed:`. */
	context?: string;
	lines?: readonly string[];
	/** Lines that did not fit. Mentioned together with the log path. */
	dropped?: number;
	logPath?: string;
	/** Point to the log even when nothing was cut, e.g. for failures. */
	alwaysLog?: boolean;
}

/**
 * Render an event message for the model and cap it at about `maxTokens`.
 * The log path is added only when lines were cut or `alwaysLog` is set, on its own line after the
 * body so it does not read like output. Body lines are dropped from the top first.
 */
export function formatEvent(message: EventMessage, maxTokens = 400): string {
	const header = `[monitor ${message.id} "${message.description}"] ${message.headline}`;
	const head = message.context ? [header, message.context] : [header];
	const body = (message.lines ?? []).map((line) => `  ${line}`);
	let dropped = message.dropped ?? 0;
	const footer = () => {
		if (!message.logPath) return [];
		if (dropped > 0) return [`log (${dropped} more lines): ${message.logPath}`];
		return message.alwaysLog ? [`log: ${message.logPath}`] : [];
	};
	const render = () => [...head, ...body, ...footer()].join("\n");
	let text = render();
	while (estimateTokens(text) > maxTokens && body.length > 0) {
		body.shift();
		dropped++;
		text = render();
	}
	if (estimateTokens(text) > maxTokens) text = text.slice(0, maxTokens * 4 - 1) + "…";
	return text;
}
