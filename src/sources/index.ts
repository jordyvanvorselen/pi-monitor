import type { MonitorSpec } from "../registry.ts";
import { commandSource } from "./command.ts";
import type { Source } from "./types.ts";

export function buildSource(spec: MonitorSpec): Source {
	switch (spec.kind) {
		case "command":
			return commandSource(spec.target);
		default:
			throw new Error(`Source ${spec.kind} is not supported yet.`);
	}
}
