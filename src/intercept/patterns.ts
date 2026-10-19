import { segments, tokenize, type Word } from "./shell.ts";

/** A blocking wait we know how to turn into a monitor. */
export type Pattern =
	| { kind: "gh_run"; target: string }
	| { kind: "gh_pr"; target: string }
	| { kind: "timer"; seconds: number; then?: string }
	| { kind: "file"; path: string; match?: string };

/** Sleeps up to this long are left alone. */
export const MAX_PLAIN_SLEEP_SECONDS = 20;

const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** `30`, `1m`, `0.5h` → seconds, or undefined. */
export function parseDuration(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(text);
	return m ? Number.parseFloat(m[1]!) * UNIT_SECONDS[m[2]!]! : undefined;
}

const allLiteral = (words: Word[]) => words.every((w) => w.literal);

/** Parse `gh <group> <verb> [positional] [flags]` with the allowed flags. Returns the positional, or null. */
function ghArgs(
	words: Word[],
	group: string,
	verb: string,
	flags: { bare: string[]; valued: string[] },
): { positional?: string; repo?: string; seen: Set<string> } | null {
	if (words[0]?.value !== "gh" || words[1]?.value !== group || words[2]?.value !== verb) return null;
	let positional: string | undefined;
	let repo: string | undefined;
	const seen = new Set<string>();
	for (let i = 3; i < words.length; i++) {
		const arg = words[i]!.value;
		const [name, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
		if (flags.bare.includes(name!)) seen.add(name!);
		else if (flags.valued.includes(name!)) {
			const value = inline ?? words[++i]?.value;
			if (value === undefined) return null;
			if (name === "-R" || name === "--repo") repo = value;
			seen.add(name!);
		} else if (!arg.startsWith("-") && positional === undefined) positional = arg;
		else return null;
	}
	return { ...(positional !== undefined ? { positional } : {}), ...(repo ? { repo } : {}), seen };
}

function ghRunWatch(words: Word[]): Pattern | undefined {
	const parsed = ghArgs(words, "run", "watch", {
		bare: ["--exit-status", "--compact"],
		valued: ["-i", "--interval", "-R", "--repo"],
	});
	if (!parsed) return undefined;
	const { positional, repo } = parsed;
	if (positional !== undefined && !/^\d+$/.test(positional)) return undefined;
	if (!positional) return repo ? undefined : { kind: "gh_run", target: "latest" };
	return { kind: "gh_run", target: repo ? `https://github.com/${repo}/actions/runs/${positional}` : positional };
}

function ghPrChecksWatch(words: Word[]): Pattern | undefined {
	const parsed = ghArgs(words, "pr", "checks", {
		bare: ["--watch", "--fail-fast", "--required"],
		valued: ["-i", "--interval", "-R", "--repo"],
	});
	if (!parsed || !parsed.seen.has("--watch")) return undefined;
	const { positional, repo } = parsed;
	const pr = positional?.replace(/^#/, "");
	if (pr !== undefined && !/^\d+$/.test(pr) && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr))
		return undefined;
	if (repo && pr && /^\d+$/.test(pr)) return { kind: "gh_pr", target: `https://github.com/${repo}/pull/${pr}` };
	if (repo) return undefined;
	return { kind: "gh_pr", target: pr ?? "" };
}

function sleepSeconds(words: Word[]): number | undefined {
	if (words[0]?.value !== "sleep" || words.length < 2) return undefined;
	let total = 0;
	for (const word of words.slice(1)) {
		const seconds = parseDuration(word.value);
		if (seconds === undefined) return undefined;
		total += seconds;
	}
	return total;
}

/** Turn a grep pattern into a JS regex, or give up. */
function grepMatch(words: Word[]): string | undefined | null {
	if (words[0]?.value !== "grep") return null;
	let extended = false;
	let pattern: string | undefined;
	for (const word of words.slice(1)) {
		const arg = word.value;
		if (arg === "--line-buffered") continue;
		if (arg === "-E" || arg === "--extended-regexp") extended = true;
		else if (arg.startsWith("-") || pattern !== undefined) return null;
		else pattern = arg;
	}
	if (pattern === undefined) return null;
	// Basic regex syntax differs from JS. Only plain words are safe without -E.
	if (!extended && /[\\^$*+?()[\]{}|]/.test(pattern)) return null;
	try {
		new RegExp(pattern);
	} catch {
		return null;
	}
	return pattern;
}

function tailFollow(words: Word[]): string | undefined {
	if (words[0]?.value !== "tail") return undefined;
	let follow = false;
	let path: string | undefined;
	for (let i = 1; i < words.length; i++) {
		const arg = words[i]!.value;
		if (arg === "-f" || arg === "-F" || arg === "--follow" || arg === "--retry") follow = true;
		else if (arg === "-n" || arg === "--lines") i++;
		else if (/^-n\d+$/.test(arg) || /^--lines=\d+$/.test(arg) || /^-\d+$/.test(arg)) continue;
		else if (/^-[fF]n?\d*$/.test(arg)) follow = true;
		else if (arg.startsWith("-") || path !== undefined) return undefined;
		else path = arg;
	}
	return follow ? path : undefined;
}

/**
 * Recognise a blocking wait. Conservative: anything with redirects, variables, globs,
 * subshells or a chain it does not fully understand returns undefined.
 */
export function matchPattern(command: string): Pattern | undefined {
	const tokens = tokenize(command);
	if (!tokens || tokens.length === 0) return undefined;
	const { commands, separators } = segments(tokens);
	if (commands.some((c) => c.redirects > 0 || c.words.length === 0 || !allLiteral(c.words))) return undefined;
	const [first, second] = commands;

	if (commands.length === 1) {
		const words = first!.words;
		const run = ghRunWatch(words) ?? ghPrChecksWatch(words);
		if (run) return run;
		const seconds = sleepSeconds(words);
		if (seconds !== undefined && seconds > MAX_PLAIN_SLEEP_SECONDS) return { kind: "timer", seconds };
		const path = tailFollow(words);
		return path ? { kind: "file", path } : undefined;
	}

	if (commands.length === 2 && separators[0] === "&&") {
		const seconds = sleepSeconds(first!.words);
		if (seconds === undefined || seconds <= MAX_PLAIN_SLEEP_SECONDS) return undefined;
		return { kind: "timer", seconds, then: second!.words.map((w) => quoteWord(w.value)).join(" ") };
	}

	if (commands.length === 2 && separators[0] === "|") {
		const path = tailFollow(first!.words);
		const match = grepMatch(second!.words);
		if (!path || !match) return undefined;
		return { kind: "file", path, match };
	}
	return undefined;
}

/** Quote a word for bash if it needs it. */
export function quoteWord(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
