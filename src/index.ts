import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CUSTOM_TYPE, Delivery, realClock, type Clock, type MonitorMessageDetails } from "./delivery.ts";
import { defaultRun } from "./exec.ts";
import { formatDuration } from "./format.ts";
import { Interceptor } from "./intercept/index.ts";
import { SafetyNet } from "./intercept/safety-net.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupOldLogs, LOG_ROOT, MonitorLog, sessionLogDir } from "./log.ts";
import { desktopNotification, openExternal } from "./notify.ts";
import { Registry, startMonitor, type MonitorEntry } from "./registry.ts";
import { planResume } from "./resume.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { buildSource } from "./sources/index.ts";
import type { Run } from "./sources/types.ts";
import { MonitorParams, prepareMonitorArgs, specFromInput, StopParams } from "./tools.ts";
import { UiController } from "./ui/controller.ts";
import { MonitorsOverlay } from "./ui/overlay.ts";
import { bashRenderer } from "./ui/bash-renderer.ts";
import { renderMonitorMessage } from "./ui/renderer.ts";

export { CUSTOM_TYPE } from "./delivery.ts";
export const ENTRY_TYPE = "monitor-state";

/** Test seams. Pi calls the factory with `pi` only. */
export interface MonitorOverrides {
	run?: Run;
	clock?: Clock;
	logRoot?: string;
	home?: string;
	notify?: (title: string, body: string) => void;
	/** Environment for the interceptor kill switch. */
	env?: NodeJS.ProcessEnv;
	/** Hands internals to tests. */
	expose?: (internals: { registry: Registry; ui: UiController; interceptor: Interceptor }) => void;
}

export default function monitorExtension(pi: ExtensionAPI, overrides: MonitorOverrides = {}) {
	const clock = overrides.clock ?? realClock;
	let settings: Settings = loadSettings(process.cwd(), overrides.home);
	let ctxRef: ExtensionContext | undefined;
	let logDir = sessionLogDir("session", overrides.logRoot);
	/** After shutdown the runtime is stale. Late source results must not touch it. */
	let shutDown = false;

	const delivery = new Delivery({
		send: (message, options) => {
			if (shutDown) return;
			pi.sendMessage(message, options);
			// An idle Pi starts a turn for this message right away.
			if (!options.deliverAs) registry.setHandling(message.details.id, true);
		},
		isIdle: () => ctxRef?.isIdle() ?? true,
		onPause: (id) => registry.markPaused(id),
		onSent: (id, tokens) => registry.addDelivered(id, tokens),
		clock,
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
		onChange: () => ui.changed(),
		onEnd: (record) => {
			ui.ended(record);
			interceptor.monitorEnded(record.id);
		},
		clock,
	});

	const ui = new UiController({
		registry,
		settings: () => settings,
		now: () => clock.now(),
		sessionName: () => pi.getSessionName(),
		notify: overrides.notify ?? desktopNotification,
	});

	const log = (message: string) => {
		try {
			const root = overrides.logRoot ?? LOG_ROOT;
			mkdirSync(root, { recursive: true });
			appendFileSync(join(root, "interceptor.log"), `${new Date().toISOString()} ${message}\n`);
		} catch {
			// logging is best effort
		}
	};

	const safetyNet = new SafetyNet({
		registry,
		logDir: () => logDir,
		shell: () => {
			const piSettings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
			return {
				path: piSettings.shellPath || "bash",
				...(piSettings.shellCommandPrefix ? { prefix: piSettings.shellCommandPrefix } : {}),
			};
		},
		thresholdSeconds: () => settings.backgroundAfterSeconds,
	});

	const interceptor = new Interceptor({
		registry,
		safetyNet,
		settings: () => settings,
		log,
		...(overrides.env ? { env: overrides.env } : {}),
	});

	overrides.expose?.({ registry, ui, interceptor });

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Start a background watcher and return at once. Sources: command (each stdout line is an event), gh_run, gh_pr, file, url, pid. " +
			"You get a message when something worth knowing happens; failures arrive at once. Give exactly one source.",
		promptSnippet: "Watch CI runs, PR checks, deploys, slow commands, files, URLs or processes in the background",
		promptGuidelines: [
			"You may run long or never-ending commands (dev servers, deploys, `gh run watch`, `sleep 60 && …`) in bash. pi-monitor moves them to the background and reports back when they end.",
			"Use `monitor` for explicit control: filter output with `match`, pick `wake`, or watch gh_run, gh_pr, url, pid or a file.",
			"Monitor messages include a log path. `read` it for the full output.",
		],
		parameters: MonitorParams,
		prepareArguments: prepareMonitorArgs,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const spec = specFromInput(params, settings.defaultTimeoutMinutes, ctx.cwd);
			const { text, record } = startMonitor(registry, spec);
			return {
				content: [{ type: "text", text }],
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
				const count = registry.stopAll("model");
				return { content: [{ type: "text", text: `Stopped ${count} monitor${count === 1 ? "" : "s"}.` }], details: {} };
			}
			if (registry.stop(id, "model")) return { content: [{ type: "text", text: `Stopped ${id}.` }], details: { id } };
			const running = registry.running().map((m) => m.id);
			throw new Error(`No running monitor ${id}. Running: ${running.length ? running.join(", ") : "none"}.`);
		},
	});

	pi.registerMessageRenderer<MonitorMessageDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(renderMonitorMessage(content, message.details, expanded, theme), 0, 0);
	});

	pi.registerToolRenderer(bashRenderer((toolCallId) => interceptor.monitorFor(toolCallId)));

	pi.registerShortcut(settings.shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Monitor dock: card, one line, hidden",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			const mode = ui.cycleMode();
			if (mode === "hidden" && registry.running().length > 0)
				ctx.ui.notify("Monitor dock hidden. The footer still shows running monitors.", "info");
		},
	});

	pi.registerCommand("monitors", {
		description: "Monitors: timeline, live log, open in browser, stop",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				const lines = registry
					.list()
					.map(
						(m) =>
							`${m.id} ${m.status} ${m.description} · ${m.summary ?? formatDuration(clock.now() - m.startedAt)} · ${m.logPath}`,
					);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No monitors in this session.", "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const unsubscribe = ui.subscribe(() => tui.requestRender());
					return new MonitorsOverlay(
						{
							items: () => registry.visible(),
							stop: (id) => {
								const record = registry.get(id);
								if (!record || !registry.stop(id, "user")) return;
								// Tell the model without waking it: it reads this with its next turn.
								pi.sendMessage(
									{
										customType: CUSTOM_TYPE,
										content: `[monitor ${id} "${record.description}"] stopped by the user.`,
										display: true,
										details: {
											id,
											description: record.description,
											kind: "final",
											status: "stopped",
											summary: "stopped by the user",
										} satisfies MonitorMessageDetails,
									},
									{ deliverAs: "nextTurn" },
								);
							},
							open: openExternal,
							now: () => clock.now(),
							frame: () => ui.currentFrame(),
							reducedMotion: () => settings.reducedMotion,
							savedTokens: () => registry.savedTokens(),
							rows: () => tui.terminal.rows,
							close: () => done(),
							requestRender: () => tui.requestRender(),
							dispose: unsubscribe,
						},
						theme,
					);
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 40, maxHeight: "85%" } },
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		shutDown = false;
		settings = loadSettings(ctx.cwd, overrides.home);
		logDir = sessionLogDir(ctx.sessionManager.getSessionId(), overrides.logRoot);
		cleanupOldLogs(overrides.logRoot);
		interceptor.reset();
		ui.attach(ctx);

		const plan = planResume(ctx.sessionManager.getBranch(), ENTRY_TYPE);
		for (const id of plan.ids) registry.reserveId(id);
		for (const { id, spec, startedAt } of plan.restart) {
			if (registry.get(id)) continue;
			try {
				registry.start(spec, { id, startedAt });
			} catch (error) {
				registry.addEnded(spec, id, startedAt, `could not restart: ${(error as Error).message}`);
			}
		}
		for (const { id, spec, startedAt } of plan.ended)
			if (!registry.get(id)) registry.addEnded(spec, id, startedAt, "ended with the session");
	});

	pi.on("agent_start", async () => ui.setStreaming(true));

	pi.on("message_start", async (event) => {
		const message = event.message as { role?: string; customType?: string; details?: { id?: unknown } };
		if (message.role === "custom" && message.customType === CUSTOM_TYPE && typeof message.details?.id === "string")
			registry.setHandling(message.details.id, true);
	});

	pi.on("agent_settled", async () => {
		ui.setStreaming(false);
		registry.clearHandling();
	});

	pi.on("tool_call", async (event, ctx) => {
		ctxRef = ctx;
		await interceptor.onToolCall(event, ctx);
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "bash") interceptor.onToolResult(event.toolCallId);
	});

	pi.on("session_shutdown", async () => {
		registry.shutdown();
		shutDown = true;
		delivery.dispose();
		safetyNet.dispose();
		interceptor.reset();
		ui.detach();
	});
}
