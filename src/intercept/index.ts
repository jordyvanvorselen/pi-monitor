import type { WakeLevel } from "../delivery.ts";
import type { MonitorSpec, Registry } from "../registry.ts";
import { startMonitor } from "../registry.ts";
import { MAX_TIMEOUT_MINUTES } from "../settings.ts";
import { matchPattern, type Pattern } from "./patterns.ts";
import { printfCommand } from "./rewrite.ts";
import { SafetyNet, shortCommand } from "./safety-net.ts";
import { CommandClassifier, isObviouslyShort, keywordGuess, type ClassifierRegistry, type Verdict } from "./triage.ts";

/** The parts of the Pi context the interceptor reads. */
export interface InterceptContext {
	cwd: string;
	hasUI: boolean;
	modelRegistry?: unknown;
	sessionManager?: { getBranch(): readonly unknown[] };
}

export interface InterceptorDeps {
	registry: Registry;
	safetyNet: SafetyNet;
	settings(): { classifier?: string; defaultTimeoutMinutes: number };
	log(message: string): void;
	env?: NodeJS.ProcessEnv;
}

function backgroundText(id: string, command: string, wake: WakeLevel): string {
	const then = wake === "events" ? "You will be notified of new lines." : "You will be notified when it ends.";
	return `Running in background as ${id} (${shortCommand(command)}). ${then}`;
}

/**
 * Monitor timeout in minutes. The model's bash `timeout` (seconds) wins when given, but never below
 * `floorSeconds` (a known sleep plus a margin). Without one, `fallbackMinutes`.
 */
export function timeoutMinutes(fallbackMinutes: number, timeoutSeconds?: number, floorSeconds = 0): number {
	const minutes = timeoutSeconds ? Math.max(timeoutSeconds, floorSeconds) / 60 : fallbackMinutes;
	return Math.min(MAX_TIMEOUT_MINUTES, minutes);
}

/** Extra time a timer gets after its sleep for the command that follows. */
const TIMER_MARGIN_SECONDS = 15;

function specFor(
	pattern: Pattern,
	command: string,
	cwd: string,
	defaultTimeout: number,
	timeoutSeconds?: number,
): MonitorSpec {
	const description = shortCommand(command);
	switch (pattern.kind) {
		case "gh_run":
		case "gh_pr":
			return {
				description,
				kind: pattern.kind,
				target: pattern.target,
				wake: "final",
				timeoutMinutes: timeoutMinutes(defaultTimeout, timeoutSeconds),
				cwd,
			};
		case "timer":
			return {
				description,
				kind: "command",
				target: command,
				wake: "final",
				timeoutMinutes: timeoutMinutes(
					Math.ceil(pattern.seconds / 60) + defaultTimeout,
					timeoutSeconds,
					pattern.seconds + TIMER_MARGIN_SECONDS,
				),
				cwd,
				reportOutput: true,
			};
		case "file":
			return {
				description,
				kind: "file",
				target: pattern.path,
				wake: "events",
				timeoutMinutes: timeoutMinutes(MAX_TIMEOUT_MINUTES, timeoutSeconds),
				cwd,
				...(pattern.match ? { match: pattern.match } : {}),
			};
	}
}

/** Text of the last assistant message on the branch, if there is one. */
export function lastAssistantText(branch: readonly unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n");
		return undefined;
	}
	return undefined;
}

/**
 * Bash interceptor. Known blocking waits become monitors, obviously short commands run normally,
 * suspects go to a classifier (or a keyword guess) and "unsure" ones to the safety net.
 * Any error leaves the command untouched.
 */
export class Interceptor {
	/** toolCallId → monitor id, for the "→ monitor m3" tag on results. Cleared when the monitor ends. */
	readonly intercepted = new Map<string, string>();
	private readonly deps: InterceptorDeps;
	private classifier: { registry: unknown; classifier: CommandClassifier } | undefined;

	constructor(deps: InterceptorDeps) {
		this.deps = deps;
	}

	/** Forget per-session state: classifier cache and intercepted calls. */
	reset(): void {
		this.classifier = undefined;
		this.intercepted.clear();
	}

	/** The monitor an intercepted bash call runs in, while that monitor runs. */
	monitorFor(toolCallId: string): string | undefined {
		return this.intercepted.get(toolCallId);
	}

	/** A monitor ended: its calls no longer get a tag. */
	monitorEnded(id: string): void {
		for (const [toolCallId, monitor] of this.intercepted) if (monitor === id) this.intercepted.delete(toolCallId);
	}

	async onToolCall(
		event: { toolName: string; toolCallId: string; input: unknown },
		ctx: InterceptContext,
	): Promise<void> {
		if (event.toolName !== "bash") return;
		const env = this.deps.env ?? process.env;
		// Print and JSON modes end after the run, so nothing would receive the later message.
		if (env.PI_MONITOR_INTERCEPT === "0" || !ctx.hasUI) return;
		const input = event.input as { command?: unknown; timeout?: unknown };
		const command = input.command;
		if (typeof command !== "string" || !command.trim()) return;
		try {
			const replacement = await this.decide(event.toolCallId, command, input.timeout, ctx);
			if (!replacement) return;
			input.command = replacement.command;
			this.intercepted.set(event.toolCallId, replacement.id);
		} catch (error) {
			this.deps.log(`intercept failed, running "${shortCommand(command)}" unchanged: ${(error as Error).message}`);
		}
	}

	/** The bash call finished. Lets the safety net clean up after an aborted wait. */
	onToolResult(toolCallId: string): void {
		this.deps.safetyNet.toolEnded(toolCallId);
	}

	private async decide(
		toolCallId: string,
		command: string,
		timeout: unknown,
		ctx: InterceptContext,
	): Promise<{ id: string; command: string } | undefined> {
		const { registry } = this.deps;
		const settings = this.deps.settings();
		const seconds = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
		const pattern = matchPattern(command);
		if (pattern) {
			const spec = specFor(pattern, command, ctx.cwd, settings.defaultTimeoutMinutes, seconds);
			const { id } = startMonitor(registry, spec);
			return { id, command: printfCommand(backgroundText(id, command, spec.wake)) };
		}
		if (isObviouslyShort(command)) return undefined;

		const verdict = await this.triage(command, ctx);
		if (verdict === "short") return undefined;
		if (verdict === "background") {
			const { id } = startMonitor(registry, {
				description: shortCommand(command),
				kind: "command",
				target: command,
				wake: "final",
				timeoutMinutes: timeoutMinutes(MAX_TIMEOUT_MINUTES, seconds),
				cwd: ctx.cwd,
				reportOutput: true,
			});
			return { id, command: printfCommand(backgroundText(id, command, "final")) };
		}
		const { id, script } = this.deps.safetyNet.start(toolCallId, command, ctx.cwd, seconds);
		return { id, command: script };
	}

	private async triage(command: string, ctx: InterceptContext): Promise<Verdict> {
		const classifier = this.classifierFor(ctx);
		if (classifier && (await classifier.available())) {
			const assistant = ctx.sessionManager ? lastAssistantText(ctx.sessionManager.getBranch()) : undefined;
			return classifier.classify(command, { cwd: ctx.cwd, ...(assistant ? { assistant } : {}) });
		}
		return keywordGuess(command);
	}

	private classifierFor(ctx: InterceptContext): CommandClassifier | undefined {
		const registry = ctx.modelRegistry as Partial<ClassifierRegistry> | undefined;
		if (!registry || typeof registry.getAvailableOfType !== "function" || typeof registry.classify !== "function")
			return undefined;
		if (this.classifier?.registry !== registry)
			this.classifier = {
				registry,
				classifier: new CommandClassifier(registry as ClassifierRegistry, this.deps.settings().classifier),
			};
		return this.classifier.classifier;
	}
}
