import type { MonitorEntry, MonitorSpec } from "./registry.ts";

export interface ResumePlan {
	/** gh watchers that had not finished. They hold no state beyond the target, so they restart. */
	restart: { id: string; spec: MonitorSpec; startedAt: number }[];
	/** Other watchers that had not finished. Their process ended with the old session. */
	ended: { id: string; spec: MonitorSpec; startedAt: number }[];
	/** Every id seen, so new ids do not collide. */
	ids: string[];
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Read our entries from the current branch and decide what to restart. */
export function planResume(branch: readonly BranchEntry[], entryType: string): ResumePlan {
	const starts = new Map<string, { spec: MonitorSpec; startedAt: number }>();
	const resolved = new Map<string, string>();
	const finished = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== entryType) continue;
		const data = entry.data as MonitorEntry | undefined;
		if (!data || typeof data !== "object" || typeof data.id !== "string") continue;
		if (data.kind === "start" && data.spec) starts.set(data.id, { spec: data.spec, startedAt: data.startedAt });
		if (data.kind === "resolve") resolved.set(data.id, data.target);
		if (data.kind === "end") finished.add(data.id);
	}
	const plan: ResumePlan = { restart: [], ended: [], ids: [...starts.keys()] };
	for (const [id, { spec, startedAt }] of starts) {
		if (finished.has(id)) continue;
		if (spec.kind === "gh_run" || spec.kind === "gh_pr") {
			const target = resolved.get(id) ?? spec.target;
			plan.restart.push({ id, spec: { ...spec, target }, startedAt });
		} else plan.ended.push({ id, spec, startedAt });
	}
	return plan;
}
