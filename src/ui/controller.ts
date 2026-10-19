import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { MonitorRecord, Registry } from "../registry.ts";
import type { DockMode, Settings } from "../settings.ts";
import { DockComponent, isVisible, renderDock } from "./dock.ts";
import type { Paint } from "./glyphs.ts";
import { monitorTitle, piTitle } from "./title.ts";

export const WIDGET_KEY = "monitor";
export const STATUS_KEY = "monitor";

/** Spinner speed while something runs. */
export const SPIN_MS = 120;
/** Clock speed when there is no spinner. */
export const CLOCK_MS = 1_000;
/** Tick while only finished rows are fading out, so the flash ends on time. */
export const FADE_MS = 250;
/** Changes closer together than this wait for the next tick. */
const BURST_MS = 100;

const NEXT_MODE: Record<DockMode, DockMode> = { card: "line", line: "hidden", hidden: "card" };

export interface ControllerDeps {
	registry: Registry;
	settings(): Settings;
	now(): number;
	sessionName(): string | undefined;
	notify(title: string, body: string): void;
}

/**
 * Owns everything the user sees outside the transcript: dock widget, footer status, terminal title,
 * desktop notifications and the animation timer. Does nothing outside TUI mode.
 */
export class UiController {
	private ctx: ExtensionContext | undefined;
	private readonly deps: ControllerDeps;
	private mode: DockMode = "card";
	private streaming = false;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private timerMs: number | undefined;
	private dock: DockComponent | undefined;
	private tui: TUI | undefined;
	private widgetShown = false;
	private status: string | undefined;
	private title: string | undefined;
	private lastRefresh = 0;
	private readonly listeners = new Set<() => void>();

	constructor(deps: ControllerDeps) {
		this.deps = deps;
	}

	/** Bind to a session context. Only TUI mode gets UI. */
	attach(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		this.ctx = ctx;
		this.mode = this.deps.settings().dock;
		this.changed(true);
	}

	/** Remove widget, status and title and stop all timers. Safe to call more than once. */
	detach(): void {
		this.stopTimer();
		const ctx = this.ctx;
		if (ctx) {
			try {
				if (this.widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
				if (this.status !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
				if (this.title !== undefined) ctx.ui.setTitle(piTitle(ctx.cwd, this.deps.sessionName()));
			} catch {
				// the UI may already be gone during shutdown
			}
		}
		this.ctx = undefined;
		this.widgetShown = false;
		this.status = undefined;
		this.title = undefined;
		this.dock = undefined;
		this.tui = undefined;
	}

	get attached(): boolean {
		return this.ctx !== undefined;
	}

	/** True while the animation timer runs. */
	get animating(): boolean {
		return this.timer !== undefined;
	}

	currentFrame(): number {
		return this.frame;
	}

	setStreaming(streaming: boolean): void {
		if (this.streaming === streaming) return;
		this.streaming = streaming;
		this.changed(true);
	}

	/** card → line → hidden → card. Returns the new mode. */
	cycleMode(): DockMode {
		this.mode = NEXT_MODE[this.mode];
		this.changed(true);
		return this.mode;
	}

	/** Subscribe to every redraw, for the overlay. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Registry changed: redraw and pick the right timer. While the timer runs, bursts of changes
	 * (a chatty command) are left to the next tick instead of redrawing on every line.
	 */
	changed(force = false): void {
		if (!this.ctx) return;
		if (!force && this.timer && this.deps.now() - this.lastRefresh < BURST_MS) {
			this.schedule();
			return;
		}
		this.refresh();
		this.schedule();
	}

	ended(record: MonitorRecord): void {
		if (!this.ctx) return;
		this.changed(true);
		if (!this.deps.settings().desktopNotifications) return;
		if (record.status !== "success" && record.status !== "failure" && record.status !== "timeout") return;
		const glyph = record.status === "success" ? "✓" : record.status === "failure" ? "✗" : "◔";
		this.deps.notify("pi · monitor", `${glyph} ${record.description}: ${record.summary ?? record.status}`);
	}

	private draw(width: number, paint: Paint): string[] {
		const settings = this.deps.settings();
		return renderDock(
			this.deps.registry.list(),
			{
				width,
				now: this.deps.now(),
				frame: this.frame,
				mode: this.mode === "line" ? "line" : "card",
				streaming: this.streaming,
				savedTokens: this.deps.registry.savedTokens(),
				shortcut: settings.shortcut,
				reducedMotion: settings.reducedMotion,
			},
			paint,
		);
	}

	private refresh(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const now = this.deps.now();
		this.lastRefresh = now;
		const records = this.deps.registry.list();
		const visible = records.some((r) => isVisible(r, now));

		if (this.mode === "hidden" || !visible) {
			if (this.widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.widgetShown = false;
			this.dock = undefined;
		} else if (!this.widgetShown) {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				this.dock = new DockComponent((width) => this.draw(width, theme));
				return this.dock;
			});
			this.widgetShown = true;
		} else {
			this.dock?.invalidate();
			this.tui?.requestRender();
		}

		const running = this.deps.registry.running().length;
		const status =
			this.mode === "hidden" && running > 0
				? ctx.ui.theme.fg("accent", "◉") + ctx.ui.theme.fg("muted", ` ${running} monitor${running === 1 ? "" : "s"}`)
				: undefined;
		if (status !== this.status) {
			ctx.ui.setStatus(STATUS_KEY, status);
			this.status = status;
		}

		const title = monitorTitle(records, now, this.frame, this.deps.settings().reducedMotion);
		if (title !== undefined && title !== this.title) ctx.ui.setTitle(title);
		else if (title === undefined && this.title !== undefined)
			ctx.ui.setTitle(piTitle(ctx.cwd, this.deps.sessionName()));
		this.title = title;

		for (const listener of this.listeners) listener();
	}

	private schedule(): void {
		const now = this.deps.now();
		const records = this.deps.registry.list();
		const running = records.some((r) => r.status === "running");
		const fading = records.some((r) => r.status !== "running" && isVisible(r, now));
		const calm = this.deps.settings().reducedMotion;
		const wanted = running ? (calm ? CLOCK_MS : SPIN_MS) : fading ? (calm ? CLOCK_MS : FADE_MS) : undefined;
		if (wanted === this.timerMs) return;
		this.stopTimer();
		if (wanted === undefined) return;
		this.timerMs = wanted;
		this.timer = setInterval(() => {
			this.frame++;
			this.refresh();
			this.schedule();
		}, wanted);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.timerMs = undefined;
	}
}
