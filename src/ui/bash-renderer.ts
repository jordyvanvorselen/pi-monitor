import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Adds one line under a result component. Keeps the inner component so the base renderer can reuse it. */
class TaggedResult implements Component {
	inner: Component;
	tag: string;

	constructor(inner: Component, tag: string) {
		this.inner = inner;
		this.tag = tag;
	}

	render(width: number): string[] {
		return [...this.inner.render(width), truncateToWidth(this.tag, width)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/**
 * Pi already shows the original command of an intercepted bash call, because it keeps the original
 * tool call arguments. This only adds `→ monitor m3` under the result while that monitor runs.
 * Everything else falls through to `next()`.
 */
export function bashRenderer(monitorFor: (toolCallId: string) => string | undefined): ToolRendererResolver {
	return (toolName, next) => {
		const base = next();
		if (toolName !== "bash" || !base?.renderResult) return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const previous = context.lastComponent;
				const inner = previous instanceof TaggedResult ? previous.inner : previous;
				const component = renderResult(result, options, theme, { ...context, lastComponent: inner });
				const id = monitorFor(context.toolCallId);
				if (!id) return component;
				const tag = theme.fg("accent", `→ monitor ${id}`);
				if (previous instanceof TaggedResult && previous.inner === component) {
					previous.tag = tag;
					return previous;
				}
				return new TaggedResult(component, tag);
			},
		};
	};
}
