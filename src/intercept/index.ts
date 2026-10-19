import type { WakeLevel } from "../delivery.ts";
import type { MonitorSpec, Registry } from "../registry.ts";
import { startMonitor } from "../registry.ts";
import { MAX_TIMEOUT_MINUTES } from "../settings.ts";
import { matchPattern, type Pattern } from "./patterns.ts";
import { printfCommand, readMarker, type Interception } from "./rewrite.ts";
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

function specFor(pattern: Pattern, command: string, cwd: string, defaultTimeout: number): MonitorSpec {
	const description = shortCommand(command);
	switch (pattern.kind) {
		case "gh_run":
		case "gh_pr":
			return {
				description,
				kind: pattern.kind,
				target: pattern.target,
				wake: "final",
				timeoutMinutes: defaultTimeout,
				cwd,
			};
		case "timer":
			return {
				description,
				kind: "command",
				target: command,
				wake: "final",
				timeoutMinutes: Math.min(MAX_TIMEOUT_MINUTES, Math.ceil(pattern.seconds / 60) + defaultTimeout),
				cwd,
				reportOutput: true,
			};
		case "file":
			return {
				description,
				kind: "file",
				target: pattern.path,
				wake: "events",
				timeoutMinutes: MAX_TIMEOUT_MINUTES,
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
	/** toolCallId → original command, for the transcript renderer. */
	readonly intercepted = new Map<string, Interception>();
	private readonly deps: InterceptorDeps;
	private classifier: { registry: unknown; classifier: CommandClassifier } | undefined;

	constructor(deps: InterceptorDeps) {
		this.deps = deps;
	}

	/** Forget per-session state (classifier cache). */
	reset(): void {
		this.classifier = undefined;
	}

	/** Look up an intercepted call: by id first, then by the marker in a rewritten command (after a restart). */
	lookup(toolCallId: string, command: unknown): Interception | undefined {
		return this.intercepted.get(toolCallId) ?? (typeof command === "string" ? readMarker(command) : undefined);
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
		if (typeof command !== "string" || !command.trim() || readMarker(command)) return;
		try {
			const replacement = await this.decide(event.toolCallId, command, input.timeout, ctx);
			if (!replacement) return;
			input.command = replacement.command;
			this.intercepted.set(event.toolCallId, { id: replacement.id, command });
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
		const pattern = matchPattern(command);
		if (pattern) {
			const spec = specFor(pattern, command, ctx.cwd, settings.defaultTimeoutMinutes);
			const { id } = startMonitor(registry, spec);
			return { id, command: printfCommand(backgroundText(id, command, spec.wake), { id, command }) };
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
				timeoutMinutes: MAX_TIMEOUT_MINUTES,
				cwd: ctx.cwd,
				reportOutput: true,
			});
			return { id, command: printfCommand(backgroundText(id, command, "final"), { id, command }) };
		}
		const seconds = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
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
