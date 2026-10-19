import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Interception } from "../intercept/rewrite.ts";

type Lookup = (toolCallId: string, command: unknown) => Interception | undefined;

/**
 * Bash calls the interceptor rewrote show the original command and `→ monitor m3`
 * instead of the printf or wait script. Everything else falls through to `next()`.
 */
export function bashRenderer(lookup: Lookup): ToolRendererResolver {
	return (toolName, next) => {
		const base = next();
		if (toolName !== "bash") return base;
		return {
			...base,
			renderCall(args, theme, context) {
				const command = (args as { command?: unknown } | undefined)?.command;
				const info = lookup(context.toolCallId, command);
				if (!info)
					return base?.renderCall ? base.renderCall(args, theme, context) : new Text(`$ ${String(command)}`, 0, 0);
				const shown = { ...(args as object), command: info.command };
				// Let the default renderer run for its side effects (timer), then replace its text.
				const component = base?.renderCall ? base.renderCall(shown, theme, context) : new Text("", 0, 0);
				const timeout = (args as { timeout?: unknown }).timeout;
				const text =
					theme.fg("toolTitle", theme.bold(`$ ${info.command}`)) +
					(typeof timeout === "number" ? theme.fg("muted", ` (timeout ${timeout}s)`) : "") +
					theme.fg("accent", `  → monitor ${info.id}`);
				if ("setText" in component && typeof component.setText === "function") {
					(component as Text).setText(text);
					return component;
				}
				return new Text(text, 0, 0);
			},
		};
	};
}
