import { segments, tokenize } from "./shell.ts";

export type Verdict = "background" | "short" | "unsure";

/** First words of commands that finish quickly. Test runners are not here on purpose: they can take long. */
const SHORT_COMMANDS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"rg",
	"grep",
	"egrep",
	"find",
	"fd",
	"echo",
	"printf",
	"pwd",
	"wc",
	"jq",
	"yq",
	"which",
	"type",
	"file",
	"stat",
	"du",
	"df",
	"env",
	"printenv",
	"date",
	"true",
	"false",
	"test",
	"[",
	"sed",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"mkdir",
	"touch",
	"cp",
	"mv",
	"rm",
	"ln",
	"chmod",
	"tree",
	"less",
	"node",
	"python",
	"python3",
	"cd",
	"export",
]);

const SHORT_GIT = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"rev-parse",
	"remote",
	"config",
	"add",
	"restore",
	"stash",
	"tag",
	"ls-files",
	"blame",
	"switch",
	"checkout",
	"commit",
]);

/** Interpreters are short only for one-liners like `node -e` or `python -c`. */
const INTERPRETER_FLAGS: Record<string, string[]> = {
	node: ["-e", "-p", "--version", "-v"],
	python: ["-c", "--version", "-V"],
	python3: ["-c", "--version", "-V"],
};

/**
 * True when every command in the line is known to be quick. `tail -f`, `less` on a pipe and similar
 * followers are excluded. Unparseable commands are never "obviously short".
 */
export function isObviouslyShort(command: string): boolean {
	const tokens = tokenize(command);
	if (!tokens || tokens.length === 0) return false;
	const { commands } = segments(tokens);
	return commands.every(({ words }) => {
		const [first, second] = words.map((w) => w.value);
		if (!first) return false;
		if (first === "git") return second !== undefined && SHORT_GIT.has(second);
		if (first === "tail" && words.some((w) => /^(-[fF]|--follow|--retry|-[fF]n?\d*)$/.test(w.value))) return false;
		if (first === "less") return false;
		const flags = INTERPRETER_FLAGS[first];
		if (flags) return second !== undefined && flags.includes(second);
		return SHORT_COMMANDS.has(first);
	});
}

const LONG_HINTS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/,
	/\b(docker[- ]compose|docker\s+compose)\s+(up|logs)\b/,
	/\b(kubectl|docker)\s+logs\b.*\s(-f|--follow)\b/,
	/\bkubectl\s+(port-forward|rollout\s+status)\b/,
	/\bjournalctl\b.*\s-f\b/,
	/--follow\b/,
	/(^|\s)(--watch|-w)(\s|$)/,
	/\b(vite|next\s+dev|nodemon|webpack-dev-server|http-server|live-server|ngrok|tunnel)\b/,
	/\bpython3?\s+-m\s+http\.server\b/,
	/\b(uvicorn|gunicorn|flask\s+run|rails\s+(s|server)|manage\.py\s+runserver)\b/,
	/\b(deploy|serve|server|listen|watch)\b/,
	/\b(terraform|tofu)\s+apply\b/,
	/\bsleep\s+\d/,
];

/** Without a classifier: a keyword match means "unsure" (the safety net decides), otherwise run normally. */
export function keywordGuess(command: string): Verdict {
	return LONG_HINTS.some((hint) => hint.test(command)) ? "unsure" : "short";
}

/** The part of `ModelRegistry` the classifier path needs. Tests pass a fake. */
export interface ClassifierRegistry {
	getAvailableOfType(type: "classifier"): Promise<readonly { provider: string; id: string }[]>;
	classify(
		model: never,
		context: {
			state: Record<string, unknown>;
			questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
		},
		options?: { signal?: AbortSignal },
	): Promise<{
		answers: Record<string, { type: string; choice?: string; confidence?: number } | undefined>;
		stopReason: string;
		errorMessage?: string;
	}>;
}

export const CLASSIFY_TIMEOUT_MS = 1_500;
export const MIN_CONFIDENCE = 0.6;

const QUESTION = {
	type: "choice" as const,
	instructions:
		"An AI coding agent is about to run `command` in a non-interactive shell and waits for it to exit. " +
		"Will it exit on its own within about 30 seconds?",
	criteria: {
		background:
			"Never exits on its own (dev server, watcher, `tail -f`, follow mode, port forward) or clearly runs for minutes (deploy, long build, full test suite)",
		short: "Exits on its own within about 30 seconds",
		unsure: "Cannot tell from the command and context",
	},
};

/**
 * Asks a classifier model whether a command is long running. Picks the pinned `provider/id` or the
 * first available classifier. Never throws: errors, timeouts and low confidence become "unsure".
 * Answers are cached per exact command for the session.
 */
export class CommandClassifier {
	private readonly cache = new Map<string, Verdict>();
	private model: Promise<{ provider: string; id: string } | undefined> | undefined;
	private readonly registry: ClassifierRegistry;
	private readonly pinned: string | undefined;
	private readonly timeoutMs: number;

	constructor(registry: ClassifierRegistry, pinned?: string, timeoutMs = CLASSIFY_TIMEOUT_MS) {
		this.registry = registry;
		this.pinned = pinned;
		this.timeoutMs = timeoutMs;
	}

	/** The classifier to use, or undefined when none is configured. */
	available(): Promise<{ provider: string; id: string } | undefined> {
		this.model ??= this.registry
			.getAvailableOfType("classifier")
			.then((models) => {
				if (this.pinned) return models.find((m) => `${m.provider}/${m.id}` === this.pinned);
				return models[0];
			})
			.catch(() => undefined);
		return this.model;
	}

	async classify(command: string, state: { cwd: string; assistant?: string }): Promise<Verdict> {
		const cached = this.cache.get(command);
		if (cached) return cached;
		const model = await this.available();
		if (!model) return "unsure";
		const { verdict, answered } = await this.ask(model, command, state);
		// Errors and timeouts are not cached, so the next call can try again.
		if (answered) this.cache.set(command, verdict);
		return verdict;
	}

	private async ask(
		model: { provider: string; id: string },
		command: string,
		state: { cwd: string; assistant?: string },
	): Promise<{ verdict: Verdict; answered: boolean }> {
		const unsure = { verdict: "unsure" as const, answered: false };
		const controller = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve("timeout");
			}, this.timeoutMs);
		});
		try {
			const result = await Promise.race([
				this.registry.classify(
					model as never,
					{
						state: {
							command,
							cwd: state.cwd,
							...(state.assistant ? { assistant_message: state.assistant.slice(-2_000) } : {}),
						},
						questions: { runtime: QUESTION },
					},
					{ signal: controller.signal },
				),
				timeout,
			]);
			if (result === "timeout" || result.stopReason !== "stop") return unsure;
			const answer = result.answers.runtime;
			if (answer?.type !== "choice") return unsure;
			const choice = answer.choice;
			const confident = (answer.confidence ?? 0) >= MIN_CONFIDENCE;
			const verdict = confident && (choice === "background" || choice === "short") ? choice : "unsure";
			return { verdict, answered: true };
		} catch {
			return unsure;
		} finally {
			clearTimeout(timer);
		}
	}

	clear(): void {
		this.cache.clear();
		this.model = undefined;
	}
}
