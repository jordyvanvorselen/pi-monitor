// Build one of Pi's built-in themes from its JSON, the way Pi does, for tests and recordings.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Theme } from "@earendil-works/pi-coding-agent";

export function piTheme(name: "dark" | "light", mode: "truecolor" | "256color" = "truecolor"): Theme {
	const dir = fileURLToPath(
		new URL("modes/interactive/theme/", import.meta.resolve("@earendil-works/pi-coding-agent")),
	);
	const json = JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as {
		vars?: Record<string, string>;
		colors: Record<string, string | number>;
	};
	const resolve = (v: string | number) => (typeof v === "string" && json.vars?.[v]) || v;
	const colors = Object.fromEntries(Object.entries(json.colors).map(([k, v]) => [k, resolve(v)]));
	return new Theme(colors as never, colors as never, mode, { name, appearance: name });
}
