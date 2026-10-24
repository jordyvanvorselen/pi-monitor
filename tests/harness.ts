import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext, { type MonitorOverrides } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export interface Sent {
	message: { customType: string; content: string; display: boolean; details: Record<string, unknown> };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

interface ToolDef {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}

/** A stub `pi` and `ctx` that record what the extension does. Headless unless `ui` is given. */
export function harness(
	options: {
		overrides?: MonitorOverrides;
		branch?: unknown[];
		idle?: boolean;
		ui?: unknown;
		modelRegistry?: unknown;
		piSettings?: Record<string, unknown>;
	} = {},
) {
	const handlers: Record<string, Handler[]> = {};
	const tools: Record<string, ToolDef> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const shortcuts: Record<string, (ctx: unknown) => unknown> = {};
	const completions: Record<string, ((prefix: string) => unknown) | undefined> = {};
	const renderers: Record<string, unknown> = {};
	const sent: Sent[] = [];
	const entries: { customType: string; data: Record<string, unknown> }[] = [];
	const branch = options.branch ?? [];
	const state = { idle: options.idle ?? true };
	const emitted: { channel: string; data: unknown }[] = [];
	const home = mkdtempSync(join(tmpdir(), "pi-monitor-home-"));
	const logRoot = mkdtempSync(join(tmpdir(), "pi-monitor-logs-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-monitor-cwd-"));
	const pi = {
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
		registerTool: (tool: ToolDef) => (tools[tool.name] = tool),
		registerCommand: (
			name: string,
			opts: {
				handler: (args: string, ctx: unknown) => Promise<void>;
				getArgumentCompletions?: (prefix: string) => unknown;
			},
		) => {
			commands[name] = opts.handler;
			completions[name] = opts.getArgumentCompletions;
		},
		registerShortcut: (key: string, opts: { handler: (ctx: unknown) => unknown }) => (shortcuts[key] = opts.handler),
		registerMessageRenderer: (type: string, renderer: unknown) => (renderers[type] = renderer),
		registerEntryRenderer: (type: string, renderer: unknown) => (renderers[`entry:${type}`] = renderer),
		sendMessage: (message: Sent["message"], opts: Sent["options"]) => sent.push({ message, options: opts }),
		appendEntry: (customType: string, data: Record<string, unknown>) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		getSessionName: () => undefined,
		getSettings: () => options.piSettings ?? {},
		registerToolRenderer: (resolver: unknown) => (renderers["tool"] = resolver),
		events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
	};
	const ctx = {
		cwd,
		mode: options.ui ? "tui" : "print",
		hasUI: Boolean(options.ui),
		ui: options.ui ?? {},
		isIdle: () => state.idle,
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		sessionManager: { getSessionId: () => "test-session", getBranch: () => branch, getCwd: () => cwd },
	};
	// No real Herdr, even when the tests run inside one.
	ext(pi as never, { home, logRoot, env: {}, ...options.overrides });
	const fire = async (event: string, payload: object = {}) => {
		let result: unknown;
		for (const handler of handlers[event] ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
		return result as Record<string, unknown> | undefined;
	};
	const call = async (name: string, params: Record<string, unknown>) => {
		const tool = tools[name]!;
		const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
		return tool.execute("call-1", prepared, undefined, undefined, ctx);
	};
	return {
		fire,
		call,
		tools,
		commands,
		shortcuts,
		renderers,
		sent,
		entries,
		branch,
		state,
		ctx,
		logRoot,
		cwd,
		home,
		emitted,
		completions,
	};
}
