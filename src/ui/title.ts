import { basename } from "node:path";
import { byImportance, displayName, LINGER_MS, type DockItem } from "./dock.ts";
import { jobCounts, spinner } from "./glyphs.ts";

function shortLabel(item: DockItem): string {
	return displayName(item).replace(/\s+#\d+$/, "");
}

/**
 * Terminal title while monitors matter: `⠹ pi · CI 3/5`, then `✓ CI green` or `✗ CI failed`
 * for a few seconds after the end. Undefined means "give the title back to Pi".
 */
export function monitorTitle(
	items: readonly DockItem[],
	now: number,
	frame: number,
	reducedMotion: boolean,
): string | undefined {
	// Commands on probation may still end within seconds and hand their result to bash. Leave the title alone.
	const running = byImportance(items.filter((i) => i.status === "running" && i.probationUntil === undefined));
	const top = running[0];
	if (top) {
		const jobs = top.progress.jobs;
		const progress = jobs?.length ? ` ${jobCounts(jobs).done}/${jobs.length}` : "";
		const more = running.length > 1 ? ` +${running.length - 1}` : "";
		return `${spinner(frame, reducedMotion)} pi · ${shortLabel(top)}${progress}${more}`;
	}
	const recent = items
		.filter((i) => i.endedAt !== undefined && now - i.endedAt < LINGER_MS)
		.sort((a, b) => b.endedAt! - a.endedAt!)[0];
	if (!recent) return undefined;
	const label = shortLabel(recent);
	const gh = recent.kind === "gh_run" || recent.kind === "gh_pr";
	if (recent.status === "success") return `✓ ${label} ${gh ? "green" : "done"}`;
	if (recent.status === "failure") return `✗ ${label} failed`;
	if (recent.status === "timeout") return `◔ ${label} timed out`;
	return undefined;
}

/** The title Pi itself sets: `π - <session> - <cwd>`. */
export function piTitle(cwd: string, sessionName: string | undefined): string {
	const dir = basename(cwd);
	return sessionName ? `π - ${sessionName} - ${dir}` : `π - ${dir}`;
}
