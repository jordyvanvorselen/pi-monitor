import { Type, type Static } from "typebox";
import type { WakeLevel } from "./delivery.ts";
import { MAX_TIMEOUT_MINUTES } from "./settings.ts";
import type { MonitorSpec } from "./registry.ts";
import type { SourceKind } from "./sources/types.ts";

const WakeSchema = Type.Unsafe<WakeLevel>({
	type: "string",
	enum: ["final", "events", "never"],
	description:
		'"final": one message when it ends (default for gh_run, gh_pr, url, pid). "events": every matching line (default for command and file). "never": UI only. Failures always wake unless "never".',
});

export const MonitorParams = Type.Object({
	description: Type.String({ description: 'Short label for UI and events, e.g. "CI for PR #42".' }),
	command: Type.Optional(
		Type.String({
			description:
				"Shell command run in the background. Each stdout line is an event, so filter it, e.g. `tail -f log | grep --line-buffered ERROR`.",
		}),
	),
	gh_run: Type.Optional(
		Type.String({ description: 'GitHub Actions run id, run URL, or "latest" for the current branch.' }),
	),
	gh_pr: Type.Optional(Type.String({ description: "Pull request number or URL. Watches all its checks." })),
	file: Type.Optional(Type.String({ description: "File to tail. Use with match." })),
	url: Type.Optional(Type.String({ description: "Wait until this URL answers 2xx." })),
	pid: Type.Optional(Type.Number({ description: "Wait until this process exits." })),
	match: Type.Optional(Type.String({ description: "Regex. Only matching lines become events (stdout and stderr)." })),
	wake: Type.Optional(WakeSchema),
	timeout_minutes: Type.Optional(Type.Number({ description: `Default 30, max ${MAX_TIMEOUT_MINUTES}.` })),
});

export type MonitorInput = Static<typeof MonitorParams>;

export const StopParams = Type.Object({
	id: Type.String({ description: 'Monitor id, e.g. "m3", or "all".' }),
});

const SOURCE_KEYS = ["command", "gh_run", "gh_pr", "file", "url", "pid"] as const satisfies readonly SourceKind[];

/** Models sometimes send numbers as strings and the other way round. */
export function prepareMonitorArgs(raw: unknown): MonitorInput {
	const args = { ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) };
	for (const key of ["gh_run", "gh_pr"]) if (typeof args[key] === "number") args[key] = String(args[key]);
	if (typeof args.pid === "string" && /^\d+$/.test(args.pid)) args.pid = Number(args.pid);
	if (typeof args.timeout_minutes === "string" && /^\d+(\.\d+)?$/.test(args.timeout_minutes))
		args.timeout_minutes = Number(args.timeout_minutes);
	for (const key of Object.keys(args)) if (args[key] === null || args[key] === "") delete args[key];
	return args as MonitorInput;
}

/** Turn tool input into a spec. Throws with a message for the model when the input is wrong. */
export function specFromInput(input: MonitorInput, defaultTimeoutMinutes: number): MonitorSpec {
	const given = SOURCE_KEYS.filter((key) => input[key] !== undefined);
	if (given.length !== 1)
		throw new Error(
			`Give exactly one source: ${SOURCE_KEYS.join(", ")}. Got ${given.length === 0 ? "none" : given.join(", ")}.`,
		);
	const kind = given[0]!;
	if (input.match !== undefined) {
		try {
			new RegExp(input.match);
		} catch (error) {
			throw new Error(`match is not a valid regex: ${(error as Error).message}`, { cause: error });
		}
	}
	const wake: WakeLevel = input.wake ?? (kind === "command" || kind === "file" ? "events" : "final");
	const timeout = Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, input.timeout_minutes ?? defaultTimeoutMinutes));
	const spec: MonitorSpec = {
		description: input.description.trim() || kind,
		kind,
		target: String(input[kind]).trim(),
		wake,
		timeoutMinutes: timeout,
	};
	if (input.match !== undefined) spec.match = input.match;
	return spec;
}
