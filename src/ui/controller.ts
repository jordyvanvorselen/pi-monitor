import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import type { MonitorRecord, Registry } from "../registry.ts";
import type { Settings } from "../settings.ts";
import type { Rgb } from "./color.ts";
import { DockComponent, isVisible, renderDock } from "./dock.ts";
import { lookFor, renderRichDock, type ThemeColors } from "./dock-rich.ts";
import type { Paint } from "./glyphs.ts";
import { monitorTitle, piTitle } from "./title.ts";

export const WIDGET_KEY = "monitor";

/** Spinner speed while something runs (plain dock, title and overlay). */
export const SPIN_MS = 120;
/** Frame interval of the colour dock while something animates, about 15 frames per second. */
export const ANIM_MS = 66;
/** Clock speed when there is no spinner. */
export const CLOCK_MS = 1_000;
/** Tick while only finished rows are fading out, so the flash ends on time. */
export const FADE_MS = 250;
/** Changes closer together than this wait for the next tick. */
const BURST_MS = 100;

export interface ControllerDeps {
	registry: Registry;
	settings(): Settings;
	now(): number;
	sessionName(): string | undefined;
	notify(title: string, body: string): void;
}

/**
 * Owns everything the user sees outside the transcript: dock widget, terminal title,
 * desktop notifications and the animation timer. Does nothing outside TUI mode.
 */
export class UiController {
	private ctx: ExtensionContext | undefined;
	private readonly deps: ControllerDeps;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private timerMs: number | undefined;
	private dock: DockComponent | undefined;
	private tui: TUI | undefined;
	private widgetShown = false;
	private title: string | undefined;
	private lastRefresh = 0;
	/** The terminal's own background, once it answered. Glows and fades blend into it. */
	private background: Rgb | undefined;
	private backgroundAsked = false;
	private readonly listeners = new Set<() => void>();

	constructor(deps: ControllerDeps) {
		this.deps = deps;
	}

	/** Bind to a session context. Only TUI mode gets UI. */
	attach(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		this.ctx = ctx;
		this.changed(true);
	}

	/** Remove widget and title and stop all timers. Safe to call more than once. */
	detach(): void {
		this.stopTimer();
		const ctx = this.ctx;
		if (ctx) {
			try {
				if (this.widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
				if (this.title !== undefined) ctx.ui.setTitle(piTitle(ctx.cwd, this.deps.sessionName()));
			} catch {
				// the UI may already be gone during shutdown
			}
		}
		this.ctx = undefined;
		this.widgetShown = false;
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

	/** Milliseconds between animation ticks, undefined when idle. */
	get interval(): number | undefined {
		return this.timerMs;
	}

	currentFrame(): number {
		return this.frame;
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
		if (!this.ctx || record.probationUntil !== undefined) return;
		this.changed(true);
		if (!this.deps.settings().desktopNotifications) return;
		if (record.status !== "success" && record.status !== "failure" && record.status !== "timeout") return;
		const glyph = record.status === "success" ? "✓" : record.status === "failure" ? "✗" : "◔";
		this.deps.notify("pi · monitor", `${glyph} ${record.description}: ${record.summary ?? record.status}`);
	}

	private draw(width: number, theme: Paint & ThemeColors): string[] {
		const settings = this.deps.settings();
		const options = {
			width,
			now: this.deps.now(),
			frame: this.frame,
			savedTokens: this.deps.registry.savedTokens(),
			shortcut: settings.shortcut,
			reducedMotion: settings.reducedMotion,
		};
		const records = this.deps.registry.visible();
		const look = lookFor(theme, this.background);
		return look ? renderRichDock(records, options, look, theme) : renderDock(records, options, theme);
	}

	/** True when the dock draws in colour with the current theme. */
	private rich(): boolean {
		try {
			return lookFor((this.ctx?.ui.theme ?? {}) as ThemeColors, this.background) !== undefined;
		} catch {
			return false;
		}
	}

	/** Ask the terminal for its background once, so glows blend into the real one. */
	private askBackground(tui: TUI, theme: ThemeColors): void {
		if (this.backgroundAsked || typeof tui.queryTerminalColors !== "function" || !lookFor(theme)) return;
		this.backgroundAsked = true;
		const apply = (colors: TerminalColors) => {
			const bg = colors.background;
			if (!bg) return;
			this.background = [bg.r, bg.g, bg.b];
			this.dock?.invalidate();
			this.tui?.requestRender();
		};
		tui
			.queryTerminalColors({ timeoutMs: 500, onLateReply: apply })
			.then(apply)
			.catch(() => {});
	}

	private refresh(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const now = this.deps.now();
		this.lastRefresh = now;
		const records = this.deps.registry.visible();
		const visible = records.some((r) => isVisible(r, now));

		if (!visible) {
			if (this.widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.widgetShown = false;
			this.dock = undefined;
		} else if (!this.widgetShown) {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				this.askBackground(tui, theme);
				this.dock = new DockComponent((width) => this.draw(width, theme));
				return this.dock;
			});
			this.widgetShown = true;
		} else {
			this.dock?.invalidate();
			this.tui?.requestRender();
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
		const records = this.deps.registry.visible();
		const running = records.some((r) => r.status === "running");
		const fading = records.some((r) => r.status !== "running" && isVisible(r, now));
		const calm = this.deps.settings().reducedMotion;
		const busy = running ? (calm ? CLOCK_MS : SPIN_MS) : fading ? (calm ? CLOCK_MS : FADE_MS) : undefined;
		// The colour dock animates by time (dissolves, glows, fades), so it needs a steady frame rate.
		const wanted = busy !== undefined && !calm && this.rich() ? ANIM_MS : busy;
		if (wanted === this.timerMs) return;
		this.stopTimer();
		if (wanted === undefined) return;
		this.timerMs = wanted;
		this.timer = setInterval(() => {
			// From the clock, not per tick: the spinner keeps its speed whatever the frame rate.
			this.frame = Math.floor(this.deps.now() / SPIN_MS);
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
