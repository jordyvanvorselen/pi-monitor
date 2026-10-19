import type { MonitorSpec } from "../registry.ts";
import { commandSource } from "./command.ts";
import { ghPrSource } from "./gh-pr.ts";
import { ghRunSource } from "./gh-run.ts";
import type { Source } from "./types.ts";

export function buildSource(spec: MonitorSpec): Source {
	switch (spec.kind) {
		case "command":
			return commandSource(spec.target);
		case "gh_run":
			return ghRunSource(spec.target);
		case "gh_pr":
			return ghPrSource(spec.target);
		default:
			throw new Error(`Source ${spec.kind} is not supported yet.`);
	}
}
