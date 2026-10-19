import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "../registry.ts";
import { startMonitor } from "../registry.ts";
import { MAX_TIMEOUT_MINUTES } from "../settings.ts";
import { commandSource } from "../sources/command.ts";
import { waitScript } from "./rewrite.ts";

export interface SafetyNetDeps {
	registry: Registry;
	logDir(): string;
	/** Pi's shell (`shellPath` setting) and `shellCommandPrefix`. */
	shell(): { path: string; prefix?: string };
	thresholdSeconds(): number;
}

interface Pending {
	id: string;
	decided: boolean;
	timer: NodeJS.Timeout | undefined;
}

export function shortCommand(command: string, max = 60): string {
	const line = command.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Runs an "unsure" command itself and hands bash a small wait script instead.
 * Ends within the threshold: the wait script prints the output and exits with the real code.
 * Still running: the wait script says so and exits 0; the command keeps running as a monitor that
 * wakes the model when it ends.
 */
export class SafetyNet {
	private readonly pending = new Map<string, Pending>();
	private readonly deps: SafetyNetDeps;

	constructor(deps: SafetyNetDeps) {
		this.deps = deps;
	}

	/** Start `command` and return the wait script that replaces it. Throws when nothing was started. */
	start(toolCallId: string, command: string, cwd: string, timeoutSeconds?: number): { id: string; script: string } {
		const { registry } = this.deps;
		const threshold = this.deps.thresholdSeconds();
		// The bash tool kills the wait script at its timeout, so decide just before that.
		const timesOut = timeoutSeconds !== undefined && timeoutSeconds > 0 && timeoutSeconds <= threshold;
		const deadlineMs = timesOut ? Math.max(100, timeoutSeconds * 1000 - 500) : threshold * 1000;

		const dir = this.deps.logDir();
		mkdirSync(dir, { recursive: true });
		const shell = this.deps.shell();
		const child = spawn(shell.path, ["-c", shell.prefix ? `${shell.prefix}\n${command}` : command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PAGER: "cat", GH_PAGER: "cat", GIT_PAGER: "cat" },
		});
		const label = shortCommand(command);
		const { id, record } = startMonitor(
			registry,
			{
				description: label,
				kind: "command",
				target: command,
				wake: "never",
				// The model's bash timeout bounds the whole run, also after a move to the background.
				timeoutMinutes: timeoutSeconds ? Math.min(MAX_TIMEOUT_MINUTES, timeoutSeconds / 60) : MAX_TIMEOUT_MINUTES,
				cwd,
				reportOutput: true,
			},
			{
				source: commandSource({ kind: "child", child, label: command, reportOutput: true }),
				probationUntil: Date.now() + deadlineMs,
			},
		);

		const statusPath = join(dir, `${id}.status`);
		const outputPath = join(dir, `${id}.out`);
		writeFileSync(outputPath, "");
		const entry: Pending = { id, decided: false, timer: undefined };
		this.pending.set(toolCallId, entry);

		const writeStatus = (status: string) => {
			writeFileSync(`${statusPath}.tmp`, status);
			renameSync(`${statusPath}.tmp`, statusPath);
		};
		const decide = (status: string) => {
			if (entry.decided) return false;
			entry.decided = true;
			clearTimeout(entry.timer);
			writeStatus(status);
			return true;
		};
		const capture = (chunk: Buffer) => {
			if (!entry.decided) appendFileSync(outputPath, chunk);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.on("error", (error) => {
			capture(Buffer.from(`pi-monitor: could not start ${shell.path}: ${error.message}\n`));
			if (decide("exit:127")) this.discardWhenDone(id);
		});
		child.on("close", (code, signal) => {
			const exit = code ?? 128 + (signal ? signalNumber(signal) : 1);
			if (decide(`exit:${exit}`)) this.discardWhenDone(id);
		});

		entry.timer = setTimeout(() => {
			if (record.status !== "running") return;
			if (timesOut) {
				if (decide("timeout")) {
					registry.stop(id, "timeout");
					this.discardWhenDone(id);
				}
				return;
			}
			if (decide("bg")) registry.reveal(id, "final");
		}, deadlineMs);
		entry.timer.unref?.();

		const movedText = `Still running after ${Math.round(deadlineMs / 1000)}s. Moved to background as ${id} (${label}). You will be notified when it ends.`;
		const script = waitScript(
			{
				statusPath,
				outputPath,
				maxWaitSeconds: deadlineMs / 1000 + 15,
				movedText,
				...(timeoutSeconds ? { timeoutSeconds } : {}),
			},
			id,
		);
		return { id, script };
	}

	/** The bash call ended. If the wait script died before a decision (abort), stop the command too. */
	toolEnded(toolCallId: string): void {
		const entry = this.pending.get(toolCallId);
		if (!entry) return;
		this.pending.delete(toolCallId);
		if (entry.decided) return;
		entry.decided = true;
		clearTimeout(entry.timer);
		// The wait script died first, usually because the user aborted the bash call.
		this.deps.registry.stop(entry.id, "user");
		this.discardWhenDone(entry.id);
	}

	dispose(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}

	/** Remove a command that ended before it was moved to the background. Its result went to bash. */
	private discardWhenDone(id: string, attempts = 40): void {
		const record = this.deps.registry.get(id);
		if (!record) return;
		if (record.status !== "running") return this.deps.registry.discard(id);
		if (attempts > 0) setTimeout(() => this.discardWhenDone(id, attempts - 1), 50).unref?.();
	}
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

function signalNumber(signal: NodeJS.Signals): number {
	return SIGNALS[signal] ?? 1;
}
