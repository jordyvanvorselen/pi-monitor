import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Delivery, type Clock } from "./delivery.ts";
import { defaultRun } from "./exec.ts";
import { blockingWaitReason } from "./guard.ts";
import { cleanupOldLogs, MonitorLog, sessionLogDir } from "./log.ts";
import { Registry, type MonitorEntry } from "./registry.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { buildSource } from "./sources/index.ts";
import type { Run } from "./sources/types.ts";
import { MonitorParams, prepareMonitorArgs, specFromInput, startedText, StopParams } from "./tools.ts";

export { CUSTOM_TYPE } from "./delivery.ts";
export const ENTRY_TYPE = "monitor-state";

export interface MonitorOverrides {
	run?: Run;
	clock?: Clock;
	logRoot?: string;
	home?: string;
}

export default function monitorExtension(pi: ExtensionAPI, overrides: MonitorOverrides = {}) {
	let settings: Settings = loadSettings(process.cwd(), overrides.home);
	let ctxRef: ExtensionContext | undefined;
	let logDir = sessionLogDir("session", overrides.logRoot);
	/** After shutdown the runtime is stale. Late source results must not touch it. */
	let shutDown = false;

	const delivery = new Delivery({
		send: (message, options) => {
			if (!shutDown) pi.sendMessage(message, options);
		},
		isIdle: () => ctxRef?.isIdle() ?? true,
		onPause: (id) => registry.markPaused(id),
		onSent: (id, tokens) => registry.addDelivered(id, tokens),
		...(overrides.clock ? { clock: overrides.clock } : {}),
	});

	const registry: Registry = new Registry({
		delivery,
		buildSource,
		openLog: (id) => MonitorLog.open(logDir, id),
		run: overrides.run ?? defaultRun,
		cwd: () => ctxRef?.cwd ?? process.cwd(),
		maxConcurrent: () => settings.maxConcurrent,
		persist: (entry) => {
			if (!shutDown) pi.appendEntry<MonitorEntry>(ENTRY_TYPE, entry);
		},
		onChange: () => {},
		...(overrides.clock ? { clock: overrides.clock } : {}),
	});

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Start a background watcher and return at once. Sources: command (each stdout line is an event), gh_run, gh_pr, file, url, pid. " +
			"You get a message when something worth knowing happens; failures arrive at once. Give exactly one source.",
		promptSnippet: "Watch CI runs, PR checks, deploys, slow commands, files, URLs or processes in the background",
		promptGuidelines: [
			"To wait for CI, deploys, builds or slow commands, start a `monitor` and continue working. Do not sleep or poll in bash. Monitors report back on their own.",
			"Monitor messages include a log path. Use `read` on it when you need the full output.",
		],
		parameters: MonitorParams,
		prepareArguments: prepareMonitorArgs,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const spec = specFromInput(params, settings.defaultTimeoutMinutes);
			const record = registry.start(spec);
			return {
				content: [{ type: "text", text: startedText(record.id, record.description, record.label, record.wake) }],
				details: { id: record.id, kind: record.kind, wake: record.wake, logPath: record.logPath },
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop monitor",
		description: 'Stop a monitor by id, or "all".',
		parameters: StopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const id = params.id.trim();
			if (id === "all") {
				const count = registry.stopAll();
				return { content: [{ type: "text", text: `Stopped ${count} monitor${count === 1 ? "" : "s"}.` }], details: {} };
			}
			if (registry.stop(id)) return { content: [{ type: "text", text: `Stopped ${id}.` }], details: { id } };
			const running = registry.running().map((m) => m.id);
			throw new Error(`No running monitor ${id}. Running: ${running.length ? running.join(", ") : "none"}.`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		shutDown = false;
		settings = loadSettings(ctx.cwd, overrides.home);
		logDir = sessionLogDir(ctx.sessionManager.getSessionId(), overrides.logRoot);
		cleanupOldLogs(overrides.logRoot);
	});

	pi.on("tool_call", async (event) => {
		if (!settings.blockBlockingWaits || event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const reason = blockingWaitReason(command);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("session_shutdown", async () => {
		shutDown = true;
		registry.stopAll();
		delivery.dispose();
	});
}
