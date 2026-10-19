import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatDuration } from "../format.ts";
import type { Job } from "../sources/types.ts";
import { byImportance, displayName, renderRow, type DockItem, type DockOptions } from "./dock.ts";
import { sparkline, type Color, type Paint } from "./glyphs.ts";

export interface OverlayItem extends DockItem {
	logPath: string;
	log: { tail: string[] };
}

export interface OverlayDeps {
	items(): OverlayItem[];
	stop(id: string): void;
	open(target: string): void;
	now(): number;
	frame(): number;
	reducedMotion(): boolean;
	savedTokens(): number;
	rows(): number;
	close(): void;
	requestRender(): void;
	/** Called when Pi disposes the overlay. */
	dispose?(): void;
}

const JOB_BAR: Record<Job["state"], [string, Color]> = {
	success: ["█", "success"],
	failure: ["█", "error"],
	running: ["▓", "accent"],
	queued: ["░", "dim"],
	skipped: ["░", "dim"],
};

/** Per-job Gantt rows. The time axis runs from the first start to now (or the end). */
export function ganttRows(jobs: readonly Job[], from: number, to: number, width: number, paint: Paint): string[] {
	if (jobs.length === 0) return [];
	const nameWidth = Math.min(18, Math.max(...jobs.map((j) => visibleWidth(j.name))));
	const clockWidth = 7;
	const barWidth = Math.max(8, width - nameWidth - clockWidth - 2);
	const span = Math.max(1, to - from);
	const col = (t: number) => Math.max(0, Math.min(barWidth, Math.round(((t - from) / span) * barWidth)));
	return jobs.map((job) => {
		const name = truncateToWidth(job.name, nameWidth, "…", true);
		const [char, color] = JOB_BAR[job.state];
		let bar: string;
		if (job.startedAt === undefined) bar = " ".repeat(barWidth);
		else {
			const start = col(job.startedAt);
			const end = Math.max(start + 1, col(job.completedAt ?? to));
			bar =
				" ".repeat(start) +
				paint.fg(color, char.repeat(Math.min(barWidth, end) - start)) +
				" ".repeat(Math.max(0, barWidth - end));
		}
		const took =
			job.startedAt !== undefined ? formatDuration((job.completedAt ?? to) - job.startedAt).padStart(clockWidth) : "";
		return `${paint.fg("muted", name)} ${bar} ${paint.fg("dim", took.padStart(clockWidth))}`;
	});
}

/** `/monitors`: list, timeline and live log of the selected monitor. */
export class MonitorsOverlay implements Component {
	private selected = 0;
	private view: "list" | "log" = "list";
	/** Lines scrolled up from the end in the log view. */
	private scroll = 0;
	private readonly deps: OverlayDeps;
	private readonly paint: Paint;

	constructor(deps: OverlayDeps, paint: Paint) {
		this.deps = deps;
		this.paint = paint;
	}

	private items(): OverlayItem[] {
		return byImportance(this.deps.items()) as OverlayItem[];
	}

	private current(): OverlayItem | undefined {
		const items = this.items();
		this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
		return items[this.selected];
	}

	handleInput(data: string): void {
		const item = this.current();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || (this.view === "list" && data === "q")) {
			if (this.view === "log") {
				this.view = "list";
				this.scroll = 0;
			} else return this.deps.close();
		} else if (matchesKey(data, "up")) {
			if (this.view === "log") this.scroll++;
			else this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			if (this.view === "log") this.scroll = Math.max(0, this.scroll - 1);
			else this.selected++;
		} else if (matchesKey(data, "pageUp")) this.scroll += 10;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 10);
		else if (matchesKey(data, "enter") && item) {
			this.view = this.view === "log" ? "list" : "log";
			this.scroll = 0;
		} else if (data === "o" && item) {
			const target = item.progress.url ?? item.logPath;
			if (target) this.deps.open(target);
		} else if (data === "s" && item?.status === "running") this.deps.stop(item.id);
		else return;
		this.deps.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.deps.dispose?.();
	}

	render(width: number): string[] {
		const p = this.paint;
		const inner = Math.max(10, width - 4);
		const side = p.fg("border", "│");
		const row = (text: string) => `${side} ${truncateToWidth(text, inner, "…", true)} ${side}`;
		const rule = (label: string) => {
			const text = label ? `─ ${truncateToWidth(label, Math.max(4, width - 6), "…")} ` : "";
			return (
				p.fg("border", "├") +
				p.fg("border", text) +
				p.fg("border", "─".repeat(Math.max(0, width - 2 - visibleWidth(text)))) +
				p.fg("border", "┤")
			);
		};
		const items = this.items();
		const item = this.current();
		const now = this.deps.now();
		const keys =
			this.view === "log"
				? "↑↓ scroll · enter/esc back · o open"
				: "↑↓ select · enter log · o open · s stop · esc close";
		const top =
			p.fg("border", "╭─ ") +
			p.bold(p.fg("accent", "monitors")) +
			p.fg("border", " " + "─".repeat(Math.max(0, width - 13)) + "╮");
		const bottomText = ` ${keys} `;
		const bottom =
			p.fg("border", "╰─") +
			p.fg("dim", bottomText) +
			p.fg("border", "─".repeat(Math.max(0, width - 4 - visibleWidth(bottomText))) + "─╯");
		const lines = [truncateToWidth(top, width)];
		if (!item) {
			lines.push(row(p.fg("dim", "No monitors in this session yet.")));
			lines.push(truncateToWidth(bottom, width));
			return lines;
		}

		const options: DockOptions = {
			width: inner - 2,
			now,
			frame: this.deps.frame(),
			mode: "card",
			streaming: false,
			savedTokens: this.deps.savedTokens(),
			shortcut: "",
			reducedMotion: this.deps.reducedMotion(),
		};
		// The overlay may use 85% of the terminal height.
		const maxRows = Math.max(12, Math.floor(this.deps.rows() * 0.85));

		if (this.view === "log") {
			lines.push(rule(`${displayName(item)} · ${item.logPath || "no log"}`));
			const height = Math.max(5, maxRows - 3);
			const tail = item.log.tail;
			this.scroll = Math.min(this.scroll, Math.max(0, tail.length - height));
			const end = tail.length - this.scroll;
			const visible = tail.slice(Math.max(0, end - height), end);
			for (const line of visible) lines.push(row(p.fg("toolOutput", line)));
			if (visible.length === 0) lines.push(row(p.fg("dim", "(no output yet)")));
			lines.push(truncateToWidth(bottom, width));
			return lines;
		}

		for (const [index, entry] of items.slice(0, 8).entries()) {
			const marker = index === this.selected ? p.fg("accent", "›") : " ";
			lines.push(row(`${marker} ${renderRow(entry, inner - 2, options, p)}`));
		}
		if (items.length > 8) lines.push(row(p.fg("dim", `  +${items.length - 8} more`)));

		const jobs = item.progress.jobs ?? [];
		if (jobs.length > 0) {
			lines.push(rule(`${displayName(item)} · timeline`));
			const starts = jobs.map((j) => j.startedAt).filter((t): t is number => t !== undefined);
			const from = Math.min(item.progress.startedAt ?? Infinity, ...starts, item.startedAt);
			const to = item.endedAt ?? now;
			const room = Math.max(3, Math.min(10, maxRows - lines.length - 6));
			const gantt = ganttRows(jobs.slice(0, room), from, to, inner, p);
			for (const line of gantt) lines.push(row(line));
			if (jobs.length > room) lines.push(row(p.fg("dim", `+${jobs.length - room} more jobs`)));
		} else {
			lines.push(rule(`${displayName(item)} · activity`));
			lines.push(row(`${sparkline(item.activity, now, p, Math.min(24, inner - 20))}  ${p.fg("dim", "lines per 10s")}`));
		}

		lines.push(rule(`log · ${item.logPath || "none"}`));
		const tail = item.log.tail.slice(-Math.max(3, maxRows - lines.length - 1));
		for (const line of tail) lines.push(row(p.fg("toolOutput", line)));
		if (tail.length === 0) lines.push(row(p.fg("dim", "(no output yet)")));
		lines.push(truncateToWidth(bottom, width));
		return lines;
	}
}
