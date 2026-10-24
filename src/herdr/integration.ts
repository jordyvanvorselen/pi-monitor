import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Clock } from "../delivery.ts";
import type { MonitorRecord } from "../registry.ts";
import { saveUserSetting, type Settings } from "../settings.ts";
import { finishedText, type DockItem } from "../ui/dock.ts";
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
import { HerdrSidebar } from "./sidebar.ts";
import { capChars, GLYPHS, PANE_TOKEN } from "./tokens.ts";

export const STARTUP_NOTE =
	"Herdr detected. Show monitors in the Herdr sidebar: /monitors herdr. Hide this note: /monitors herdr off";

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
}

type Ui = { notify(message: string, type?: "info" | "warning" | "error"): void; theme?: unknown };

/** Herdr sidebar tokens, toasts and the blocked mark, for pi running in a Herdr pane. */
export class HerdrIntegration {
	readonly target: HerdrTarget | undefined;
	private readonly deps: HerdrDeps;
	private readonly client: HerdrClient | undefined;
	private readonly attention: Attention;
	private sidebar: HerdrSidebar | undefined;
	private tui = false;
	private noteShown = false;

	constructor(deps: HerdrDeps) {
		this.deps = deps;
		this.target = detectHerdr(deps.env);
		this.client = this.target
			? new HerdrClient({ socketPath: this.target.socketPath, log: deps.log, now: () => deps.clock.now() })
			: undefined;
		this.attention = new Attention({
			emit: (channel, data) => deps.emit(channel, data),
			get: (id) => deps.get(id),
			clock: deps.clock,
		});
	}

	/** Inside Herdr, in the terminal UI, and turned on. */
	get active(): boolean {
		return this.target !== undefined && this.tui && this.deps.settings().herdr === "on";
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
		if (!this.target || !this.tui || this.deps.settings().herdr !== undefined) return;
		this.noteShown = true;
		ui.notify(STARTUP_NOTE, "info");
	}

	/** Monitors changed. */
	changed(): void {
		if (!this.active) return;
		this.sidebar?.update();
		this.attention.sync(this.deps.monitors().filter((m) => m.status === "running"));
	}

	/** A monitor ended. Failures may mark the pane as blocked. */
	ended(record: MonitorRecord): void {
		if (!this.active || !this.deps.settings().herdrAttention || record.probationUntil !== undefined) return;
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
		const glyph =
			record.status === "success" ? GLYPHS.success : record.status === "timeout" ? GLYPHS.timeout : GLYPHS.failure;
		void this.client
			.request("notification.show", {
				title: capChars(`${glyph} ${finishedText(record)}`, 80),
				body: `pi · ${basename(this.deps.cwd())}`,
				sound: record.status === "success" ? "done" : "request",
			})
			.then((reply) => {
				if (!reply) fallback();
				else if (reply.result?.reason && reply.result.reason !== "shown")
					this.deps.log(`herdr: notification not shown: ${String(reply.result.reason)}`);
			});
	}

	/** `/monitors herdr [off|status]`. */
	async command(args: string, ui: Ui): Promise<void> {
		const sub = args.trim();
		try {
			if (sub === "" || sub === "on") return await this.setup(ui);
			if (sub === "off") return await this.turnOff(ui);
			if (sub === "status") return ui.notify(this.status(), "info");
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
		if (this.active && this.target && this.client && !this.sidebar) {
			const client = this.client;
			this.sidebar = new HerdrSidebar({
				request: (method, params) => client.request(method, params),
				paneId: this.target.paneId,
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
		const look = theme ? lookFor(theme as ThemeColors) : undefined;
		if (!look) return DEFAULT_PALETTE;
		const hex = (rgb: readonly number[]) =>
			`#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
		return { ok: hex(look.success), failed: hex(look.error), running: hex(look.warning) };
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
			return ui.notify(lines.join("\n"), "warning");
		}

		if (!result.changed) lines.push(`Herdr config: ${this.tilde(path)} already has the monitor row.`);
		else {
			const row = `the $${PANE_TOKEN} agent row`;
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
		ui.notify(lines.join("\n"), level);
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
				`The $${PANE_TOKEN} row in ${this.tilde(path)} stays and shows nothing. To remove it, delete that row below the "${MARKER}" comment.`,
			);
		ui.notify(lines.join("\n"), "info");
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
			`Config: ${this.hasRows(path) ? "has a" : "no"} monitor row in ${this.tilde(path)}`,
			`Blocked mark on failures (herdrAttention): ${this.deps.settings().herdrAttention ? "on" : "off"}`,
			...(this.client?.backingOff ? ["Herdr did not answer the last request. pi-monitor tries again later."] : []),
		].join("\n");
	}
}
