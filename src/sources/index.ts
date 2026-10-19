import type { MonitorSpec } from "../registry.ts";
import { commandSource } from "./command.ts";
import { fileSource } from "./file.ts";
import { ghPrSource } from "./gh-pr.ts";
import { ghRunSource } from "./gh-run.ts";
import { pidSource } from "./pid.ts";
import type { Source } from "./types.ts";
import { urlSource } from "./url.ts";

export function buildSource(spec: MonitorSpec): Source {
	switch (spec.kind) {
		case "command":
			return commandSource({ kind: "spawn", command: spec.target, reportOutput: spec.reportOutput === true });
		case "gh_run":
			return ghRunSource(spec.target, {
				...(spec.branch ? { branch: spec.branch } : {}),
				...(spec.workflow ? { workflow: spec.workflow } : {}),
			});
		case "gh_pr":
			return ghPrSource(spec.target);
		case "file":
			return fileSource(spec.target);
		case "url":
			return urlSource(spec.target);
		case "pid":
			return pidSource(Number(spec.target));
	}
}
