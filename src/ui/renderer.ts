import type { MonitorMessageDetails } from "../delivery.ts";
import type { Color, Paint } from "./glyphs.ts";

function glyphFor(details: MonitorMessageDetails): [string, Color] {
	if (details.kind === "noisy") return ["‖", "warning"];
	if (details.kind === "event") return details.level === "failure" ? ["✗", "error"] : ["›", "accent"];
	switch (details.status) {
		case "success":
			return ["✓", "success"];
		case "failure":
			return ["✗", "error"];
		case "timeout":
			return ["◔", "warning"];
		default:
			return ["■", "dim"];
	}
}

/**
 * Transcript view of a monitor message. Collapsed: one line. Expanded: the text the model got.
 */
export function renderMonitorMessage(
	content: string,
	details: MonitorMessageDetails | undefined,
	expanded: boolean,
	paint: Paint,
): string {
	if (!details) return paint.fg("muted", content);
	const [glyph, color] = glyphFor(details);
	const head =
		`${paint.fg(color, glyph)} ${paint.fg("accent", "monitor")} ${paint.fg("dim", details.id)} ` +
		`${paint.fg("text", details.description)} ${paint.fg("dim", "·")} ${paint.fg("muted", details.summary)}`;
	if (!expanded) return head;
	const body = content
		.split("\n")
		.slice(1)
		.map((line) => paint.fg("toolOutput", line));
	return [head, ...body].join("\n");
}
