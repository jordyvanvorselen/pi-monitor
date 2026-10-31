import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Clock } from "../delivery.ts";
import type { MonitorRecord } from "../registry.ts";
import { isSet, saveUserSetting, userSettingsPath, type Settings } from "../settings.ts";
import { displayName, finishedText, type DockItem } from "../ui/dock.ts";
import { lookFor, type ThemeColors } from "../ui/look.ts";
import { Attention } from "./attention.ts";
import { detectHerdr, HerdrClient, herdrConfigPath, type HerdrReply, type HerdrTarget } from "./client.ts";
import {
	DEFAULT_PALETTE,
	ManualSetupError,
	manualSnippet,
	MARKER,
	OLD_SPACE_TOKEN,
	restoreHerdrConfig,
	setupHerdrConfig,
	type HerdrPalette,
	type SetupResult,
} from "./config.ts";
import { DesktopApp } from "./desktop-app.ts";
import { defaultRun, DesktopLabels, detectHerdrDesktop, type DesktopTarget, type Run } from "./desktop.ts";
import { HerdrSidebar, paneSender, type TokenSender } from "./sidebar.ts";
import { capChars, GLYPHS, PANE_TOKEN } from "./tokens.ts";

export const STARTUP_NOTE =
	"pi-monitor: Herdr detected. Show monitors in the Herdr sidebar with /monitors herdr, or hide this note with /monitors herdr off.";

export const HERDR_USAGE = "Usage: /monitors herdr [off|status]";

export interface HerdrDeps {
	env: NodeJS.ProcessEnv;
	home?: string;
	monitors(): readonly MonitorRecord[];
	get(id: string): MonitorRecord | undefined;
	settings(): Settings;
	/** Read the settings files again after a change. */
	reloadSettings(): void;
	clock: Clock;
	log(message: string): void;
	emit(channel: string, data: unknown): void;
	cwd(): string;
	/** The terminal notification, for when Herdr cannot be reached. */
	desktop(title: string, body: string): void;
	/** Runs `hc` and `herdr-app` for the Herdr desktop app. Default: the real programs. */
	run?: Run;
}

type Ui = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** pi's picker. Missing in print mode and in some tests: then the command says how to set it by hand. */
	select?(title: string, options: string[]): Promise<string | undefined>;
	theme?: unknown;
};

/** The answers `/monitors herdr` offers for the blocked mark. */
export const ATTENTION_CHOICES = {
	on: "Yes, mark pi as blocked when a monitor fails and pi is not on it",
	off: "No, only show the sidebar row and toasts",
} as const;
export const ATTENTION_QUESTION = "Mark this pi as blocked in Herdr when a monitor fails?";

/** The Herdr toast for a finished monitor: `✓ CI #42 green in 6m02s`, from `pi · <project>`. */
export function toastFor(record: DockItem, cwd: string): { title: string; body: string; sound: "done" | "request" } {
	const glyph =
		record.status === "success" ? GLYPHS.success : record.status === "timeout" ? GLYPHS.timeout : GLYPHS.failure;
	return {
		title: capChars(`${glyph} ${finishedText(record)}`, 80),
		body: `pi · ${basename(cwd)}`,
		sound: record.status === "success" ? "done" : "request",
	};
}

/** The Herdr toast for a GitHub run whose first job failed while the rest still runs: `✗ CI #42 test failed`. */
export function failingToastFor(record: DockItem, cwd: string): { title: string; body: string; sound: "request" } {
	const failed = (record.progress.jobs ?? []).filter((j) => j.state === "failure").map((j) => j.name);
	return {
		title: capChars(`${GLYPHS.failure} ${displayName(record)} ${failed.join(", ")} failed`, 80),
		body: `pi · ${basename(cwd)} · still running`,
		sound: "request",
	};
}

/**
 * Remembers which run attempts already got a toast for a failed job while running. A run attempt is a
 * monitor id plus `failingSince`: a rerun clears the failed jobs, so its first failure is new again.
 */
export class FailureToasts {
	private readonly toasted = new Map<string, number>();

	/** Running monitors that got their first failed job since the last call. Marks them as toasted. */
	due(records: readonly DockItem[]): DockItem[] {
		return records.filter((record) => {
			const since = record.failingSince;
			if (record.status !== "running" || since === undefined || this.toasted.get(record.id) === since) return false;
			this.toasted.set(record.id, since);
			return true;
		});
	}

	/**
	 * True when the end of `record` would repeat a toast that already went out: a run that ends as failed after
	 * a toast for a failed job in the same attempt. A timeout is new information and still gets its toast.
	 */
	covers(record: DockItem): boolean {
		const since = record.failingSince;
		return record.status === "failure" && since !== undefined && this.toasted.get(record.id) === since;
	}
}

/** Rule colours from pi's theme, so the sidebar matches the dock. Falls back to the launch video palette. */
export function paletteFor(theme: unknown): HerdrPalette {
	const look = theme ? lookFor(theme as ThemeColors) : undefined;
	if (!look) return DEFAULT_PALETTE;
	const hex = (rgb: readonly number[]) =>
		`#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
	return { ok: hex(look.success), failed: hex(look.error), running: hex(look.warning) };
}

/**
 * Herdr sidebar tokens, toasts and the blocked mark, for pi running in a Herdr pane. In the Herdr desktop app
 * only the sidebar part: the same tokens go out as labels on pi's terminal, and a mod shows them.
 */
export class HerdrIntegration {
	readonly target: HerdrTarget | undefined;
	/** Set when pi runs in the Herdr desktop app instead of the Herdr TUI. */
	readonly desktopTarget: DesktopTarget | undefined;
	private readonly deps: HerdrDeps;
	private readonly client: HerdrClient | undefined;
	private readonly labels: DesktopLabels | undefined;
	private readonly attention: Attention;
	private sidebar: HerdrSidebar | undefined;
	private tui = false;
	private noteShown = false;
	private readonly failures = new FailureToasts();

	constructor(deps: HerdrDeps) {
		this.deps = deps;
		this.target = detectHerdr(deps.env);
		this.desktopTarget = detectHerdrDesktop(deps.env);
		this.client = this.target
			? new HerdrClient({ socketPath: this.target.socketPath, log: deps.log, now: () => deps.clock.now() })
			: undefined;
		this.labels = this.desktopTarget
			? new DesktopLabels({
					terminal: this.desktopTarget.terminal,
					run: deps.run ?? defaultRun,
					log: deps.log,
					now: () => deps.clock.now(),
				})
			: undefined;
		this.attention = new Attention({
			emit: (channel, data) => deps.emit(channel, data),
			get: (id) => deps.get(id),
			clock: deps.clock,
		});
	}

	/** Inside Herdr (TUI or desktop app), in pi's terminal UI, and turned on. */
	get active(): boolean {
		return this.inside && this.tui && this.deps.settings().herdr === "on";
	}

	private get inside(): boolean {
		return this.target !== undefined || this.desktopTarget !== undefined;
	}

	private desktopApp(): DesktopApp {
		return new DesktopApp({ env: this.deps.env, home: this.home(), run: this.deps.run ?? defaultRun });
	}

	/** Bind to a session. Starts the sidebar when the integration is on. */
	attach(ctx: { mode: string; hasUI: boolean }): void {
		this.tui = ctx.mode === "tui" && ctx.hasUI;
		void this.apply();
	}

	/** Stop the sidebar and take back every blocked mark. Resolves when Herdr has the cleared tokens. */
	async detach(): Promise<void> {
		this.tui = false;
		await this.apply();
	}

	/** The one-time note in pi's startup area, when pi runs in Herdr and the user has not decided yet. */
	startupNote(event: { reason?: string }, ui: Ui): void {
		if (this.noteShown || event.reason !== "startup") return;
		if (!this.inside || !this.tui || this.deps.settings().herdr !== undefined) return;
		this.noteShown = true;
		// A warning, like other extensions' startup notes: pi draws it in yellow with "Warning: " in front.
		// An info line is dim grey and easy to miss among the startup output.
		ui.notify(STARTUP_NOTE, "warning");
	}

	/** Monitors changed. */
	changed(): void {
		if (!this.active) return;
		this.sidebar?.update();
		// Toasts and the blocked mark are the Herdr TUI's. The desktop app keeps pi's own notifications.
		if (!this.target) return;
		const running = this.deps.monitors().filter((m) => m.status === "running");
		this.attention.sync(running);
		for (const record of this.failures.due(running)) this.notifyFailing(record);
	}

	/** A monitor ended. Failures may mark the pane as blocked. */
	ended(record: MonitorRecord): void {
		if (!this.active || !this.target || !this.deps.settings().herdrAttention || record.probationUntil !== undefined)
			return;
		if (record.status === "failure" || record.status === "timeout") this.attention.failed(record);
	}

	/** The user typed something: they have seen it. */
	userInput(): void {
		this.attention.clearAll();
	}

	/**
	 * Notification for a finished monitor. Inside Herdr it goes to Herdr's toasts instead of the terminal escape,
	 * which Herdr does not pass on. When Herdr cannot be reached, `fallback` sends the terminal one.
	 */
	notify(record: DockItem, fallback: () => void): void {
		if (!this.active || !this.client) return fallback();
		// The failed job already had its toast while the run went on. The end says nothing new.
		if (this.failures.covers(record)) return;
		this.show(toastFor(record, this.deps.cwd()), fallback);
	}

	/** One toast when a running GitHub run first gets a failed job, once per run attempt. */
	private notifyFailing(record: DockItem): void {
		if (!this.deps.settings().desktopNotifications || record.probationUntil !== undefined) return;
		const toast = failingToastFor(record, this.deps.cwd());
		this.show(toast, () => this.deps.desktop("pi · monitor", `${toast.title}, the run goes on`));
	}

	private show(toast: { title: string; body: string; sound: string }, fallback: () => void): void {
		if (!this.client) return fallback();
		void this.client.request("notification.show", toast).then((reply) => {
			if (!reply) fallback();
			else if (reply.result?.reason && reply.result.reason !== "shown")
				this.deps.log(`herdr: notification not shown: ${String(reply.result.reason)}`);
		});
	}

	/** `/monitors herdr [off|status]`. */
	async command(args: string, ui: Ui): Promise<void> {
		const sub = args.trim();
		try {
			const desktop = this.desktopTarget !== undefined;
			if (sub === "" || sub === "on") return await (desktop ? this.setupDesktop(ui) : this.setup(ui));
			if (sub === "off") return await (desktop ? this.turnOffDesktop(ui) : this.turnOff(ui));
			if (sub === "status") return ui.notify(desktop ? await this.desktopStatus() : this.status(), "info");
			ui.notify(HERDR_USAGE, "error");
		} catch (error) {
			const command = ["/monitors herdr", sub].filter(Boolean).join(" ");
			ui.notify(`${command}: ${(error as Error).message}`, "error");
		}
	}

	private home(): string {
		return this.deps.home ?? homedir();
	}

	private tilde(path: string): string {
		const home = this.home();
		return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	}

	/** Start or stop the sidebar and the blocked mark to match the current state. */
	private async apply(): Promise<void> {
		const send: TokenSender | undefined =
			this.target && this.client
				? paneSender((method, params) => this.client!.request(method, params), this.target.paneId)
				: this.labels?.send;
		if (this.active && send && !this.sidebar) {
			this.sidebar = new HerdrSidebar({
				send,
				items: () => this.deps.monitors(),
				clock: this.deps.clock,
			});
			this.sidebar.update();
			return;
		}
		if (this.active) return;
		this.attention.clearAll();
		const sidebar = this.sidebar;
		this.sidebar = undefined;
		await sidebar?.stop();
	}

	private palette(theme: unknown): HerdrPalette {
		return paletteFor(theme);
	}

	/** Ask the herdr binary whether a config file is valid. Undefined when it is, or when we cannot tell. */
	private validate(path: string, candidate: string): string | undefined {
		const check = (file: string) => {
			const result = spawnSync(this.deps.env.HERDR_BIN_PATH || "herdr", ["config", "check"], {
				env: { ...this.deps.env, HERDR_CONFIG_PATH: file },
				encoding: "utf8",
				timeout: 5_000,
			});
			if (result.error) return undefined;
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			return /^config: ok/m.test(output) ? undefined : output.split("\n").slice(0, 4).join(" ");
		};
		const complaint = check(candidate);
		// A config that already had problems: we cannot tell ours apart, so do not block on it.
		if (complaint && existsSync(path) && check(path)) return undefined;
		return complaint;
	}

	private async reload(): Promise<{ ok: boolean; detail?: string } | undefined> {
		const reply: HerdrReply | undefined = await this.client?.request("server.reload_config", {});
		if (!reply) return undefined;
		const result = reply.result ?? {};
		const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
		if (reply.error) return { ok: false, detail: reply.error.message ?? reply.error.code ?? "refused" };
		if (result.status !== "applied" || diagnostics.length)
			return { ok: false, detail: JSON.stringify(diagnostics).slice(0, 300) };
		return { ok: true };
	}

	private async setup(ui: Ui): Promise<void> {
		const lines = ["Herdr sidebar on."];
		const settingsPath = saveUserSetting("herdr", "on", this.home());
		this.deps.reloadSettings();
		lines.push(`Setting: "herdr": "on" in the "monitor" section of ${this.tilde(settingsPath)}`);

		const path = herdrConfigPath(this.deps.env, this.home());
		let result: SetupResult | undefined;
		try {
			result = setupHerdrConfig(path, {
				palette: this.palette(ui.theme),
				validate: (candidate) => this.validate(path, candidate),
			});
		} catch (error) {
			const reason = error instanceof ManualSetupError ? error.message : (error as Error).message;
			lines.push(
				`Could not change ${this.tilde(path)}: ${reason}. Add the rows yourself:`,
				manualSnippet(this.palette(ui.theme)),
			);
			await this.apply();
			return await this.finishSetup(ui, lines, "warning");
		}

		if (!result.changed) lines.push(`Herdr config: ${this.tilde(path)} already has the monitor rows.`);
		else {
			const row = `the $${PANE_TOKEN} and counts agent rows`;
			const what = result.created
				? `created ${this.tilde(path)} with ${row}`
				: result.updated
					? `updated ${row} in ${this.tilde(path)}`
					: `added ${row} to ${this.tilde(path)}`;
			lines.push(`Herdr config: ${what}.`);
			if (result.removedSpaceRow)
				lines.push(`Removed the old ${OLD_SPACE_TOKEN} row from the space rows. Monitors now show per pane only.`);
			if (result.backup) lines.push(`Backup: ${this.tilde(result.backup)}`);
		}
		if (result.toast === "off")
			lines.push(
				'Herdr toasts are off in your config ([ui.toast] delivery = "off"). Set delivery = "herdr" to see monitor notifications.',
			);

		let level: "info" | "warning" = "info";
		if (result.changed) {
			const reload = this.target ? await this.reload() : undefined;
			if (!reload) lines.push("Run `herdr server reload-config` to apply it.");
			else if (reload.ok) lines.push("Herdr reloaded its config.");
			else {
				restoreHerdrConfig(result);
				await this.reload();
				level = "warning";
				lines.push(`Herdr did not accept the change (${reload.detail}). The old config is back.`);
			}
		}
		if (!this.target) lines.push("Monitors show in the sidebar when pi runs inside Herdr.");
		else if (!this.tui) lines.push("Monitors show in the sidebar in pi's interactive mode.");
		await this.apply();
		await this.finishSetup(ui, lines, level);
	}

	/**
	 * Show what setup did, then offer the blocked mark once: only while `herdrAttention` is not set anywhere, so
	 * people who never run the command keep the default (off). Without pi's picker, say how to turn it on.
	 */
	private async finishSetup(ui: Ui, lines: string[], level: "info" | "warning"): Promise<void> {
		const ask = !isSet("herdrAttention", this.deps.cwd(), this.home());
		const path = this.tilde(userSettingsPath(this.home()));
		if (ask && !ui.select)
			lines.push(
				`Blocked mark: add "herdrAttention": true to the "monitor" section of ${path} to mark pi as blocked in Herdr when a monitor fails and pi is not on it.`,
			);
		ui.notify(lines.join("\n"), level);
		if (!ask || !ui.select) return;
		const answer = await ui.select(ATTENTION_QUESTION, [ATTENTION_CHOICES.on, ATTENTION_CHOICES.off]);
		if (answer === undefined)
			return ui.notify(
				`Blocked mark not set. To turn it on later, add "herdrAttention": true to the "monitor" section of ${path}.`,
				"info",
			);
		const on = answer === ATTENTION_CHOICES.on;
		saveUserSetting("herdrAttention", on, this.home());
		this.deps.reloadSettings();
		ui.notify(
			on
				? `Blocked mark on. Setting: "herdrAttention": true in the "monitor" section of ${path}`
				: `Blocked mark off. Setting: "herdrAttention": false in the "monitor" section of ${path}. Set it to true to turn it on.`,
			"info",
		);
	}

	private async turnOff(ui: Ui): Promise<void> {
		const settingsPath = saveUserSetting("herdr", "off", this.home());
		this.deps.reloadSettings();
		await this.apply();
		const lines = [
			"Herdr sidebar off. pi-monitor no longer sends tokens or toasts to Herdr, and the startup note stays hidden.",
			`Setting: "herdr": "off" in the "monitor" section of ${this.tilde(settingsPath)}`,
		];
		const path = herdrConfigPath(this.deps.env, this.home());
		if (this.hasRows(path))
			lines.push(
				`The $${PANE_TOKEN} rows in ${this.tilde(path)} stay and show nothing. To remove them, delete those rows below the "${MARKER}" comment.`,
			);
		ui.notify(lines.join("\n"), "info");
	}

	private async setupDesktop(ui: Ui): Promise<void> {
		const settingsPath = saveUserSetting("herdr", "on", this.home());
		this.deps.reloadSettings();
		const lines = [
			"Herdr app agents list on.",
			`Setting: "herdr": "on" in the "monitor" section of ${this.tilde(settingsPath)}`,
		];
		let level: "info" | "warning" = "info";
		try {
			lines.push(...(await this.desktopApp().setup()));
		} catch (error) {
			level = "warning";
			lines.push(
				`Could not set up the Herdr app: ${(error as Error).message}.`,
				"pi-monitor still labels this terminal. Run /monitors herdr again to retry.",
			);
		}
		if (!this.tui) lines.push("Monitors show in the agents list in pi's interactive mode.");
		await this.apply();
		ui.notify(lines.join("\n"), level);
	}

	private async turnOffDesktop(ui: Ui): Promise<void> {
		const settingsPath = saveUserSetting("herdr", "off", this.home());
		this.deps.reloadSettings();
		await this.apply();
		const lines = [
			"Herdr app agents list off. pi-monitor no longer labels this terminal, and the startup note stays hidden.",
			`Setting: "herdr": "off" in the "monitor" section of ${this.tilde(settingsPath)}`,
		];
		let level: "info" | "warning" = "info";
		try {
			lines.push(...(await this.desktopApp().remove()));
		} catch (error) {
			level = "warning";
			lines.push(`Could not undo the Herdr app setup: ${(error as Error).message}.`);
		}
		ui.notify(lines.join("\n"), level);
	}

	private async desktopStatus(): Promise<string> {
		const setting = this.deps.settings().herdr;
		const app = this.desktopApp();
		const state = await app.state();
		const layout =
			state.layout === undefined
				? "the Herdr app did not answer"
				: `${state.layout}, ${state.showing ? "shows" : "does not show"} the monitor agents list`;
		return [
			`Herdr app: pi runs in terminal ${this.desktopTarget!.terminal}`,
			`Agents list: ${setting === "on" ? "on" : setting === "off" ? "off" : "not set up (/monitors herdr)"}${this.active ? ", labelling this terminal" : ""}`,
			`Mod: ${state.installed ? "installed" : "not installed"} in ${this.tilde(app.modFolder)}`,
			`Layout: ${layout}`,
			...(this.labels?.backingOff ? ["hc failed the last time. pi-monitor tries again later."] : []),
		].join("\n");
	}

	private hasRows(path: string): boolean {
		try {
			return readFileSync(path, "utf8").includes(`"$${PANE_TOKEN}"`);
		} catch {
			return false;
		}
	}

	private status(): string {
		const setting = this.deps.settings().herdr;
		const path = herdrConfigPath(this.deps.env, this.home());
		return [
			`Herdr: ${this.target ? `pi runs in pane ${this.target.paneId}` : "pi does not run inside Herdr"}`,
			`Sidebar: ${setting === "on" ? "on" : setting === "off" ? "off" : "not set up (/monitors herdr)"}${this.active ? ", sending" : ""}`,
			`Config: ${this.hasRows(path) ? "has" : "no"} monitor rows in ${this.tilde(path)}`,
			`Blocked mark on failures (herdrAttention): ${this.deps.settings().herdrAttention ? "on" : "off"}`,
			...(this.client?.backingOff ? ["Herdr did not answer the last request. pi-monitor tries again later."] : []),
		].join("\n");
	}
}
