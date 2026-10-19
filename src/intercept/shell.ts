// A deliberately small shell lexer. It understands words, quotes and the plain
// list/pipe operators. Anything fancier (subshells, command substitution,
// here-docs, braces) makes it give up, so callers never rewrite what they do not understand.

export interface Word {
	type: "word";
	value: string;
	/** No `$`, globs or escapes that the shell would expand. */
	literal: boolean;
}

export interface Operator {
	type: "op";
	value: "|" | "||" | "&&" | ";" | "&" | "redirect";
}

export type Token = Word | Operator;

/** Tokens, or undefined when the command uses syntax this lexer does not handle. */
export function tokenize(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let i = 0;
	let word = "";
	let inWord = false;
	let literal = true;
	const flush = () => {
		if (inWord) tokens.push({ type: "word", value: word, literal });
		word = "";
		inWord = false;
		literal = true;
	};
	while (i < command.length) {
		const c = command[i]!;
		const next = command[i + 1];
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return undefined;
			word += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let value = "";
			for (; j < command.length && command[j] !== '"'; j++) {
				const d = command[j]!;
				if (d === "`") return undefined;
				if (d === "$") {
					if (command[j + 1] === "(") return undefined;
					literal = false;
				}
				if (d === "\\" && j + 1 < command.length) {
					value += command[++j];
					continue;
				}
				value += d;
			}
			if (j >= command.length) return undefined;
			word += value;
			inWord = true;
			i = j + 1;
			continue;
		}
		if (c === "\\") {
			if (next === undefined) return undefined;
			if (next !== "\n") {
				word += next;
				inWord = true;
			}
			i += 2;
			continue;
		}
		if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return undefined;
		if (c === "$") {
			if (next === "(") return undefined;
			literal = false;
			word += c;
			inWord = true;
			i++;
			continue;
		}
		if (c === "#" && !inWord) {
			const end = command.indexOf("\n", i);
			i = end === -1 ? command.length : end;
			continue;
		}
		if (c === " " || c === "\t") {
			flush();
			i++;
			continue;
		}
		if (c === "\n" || c === ";") {
			flush();
			tokens.push({ type: "op", value: ";" });
			i++;
			continue;
		}
		if (c === "|" || c === "&") {
			flush();
			if (next === c) {
				tokens.push({ type: "op", value: c === "|" ? "||" : "&&" });
				i += 2;
			} else if (c === "&" && next === ">") {
				tokens.push({ type: "op", value: "redirect" });
				i += 2;
			} else {
				tokens.push({ type: "op", value: c });
				i++;
			}
			continue;
		}
		if (c === "<" || c === ">") {
			if (next === "<" && c === "<") return undefined; // here-doc or here-string
			// `2>` and `2>&1`: the descriptor digit belongs to the redirect.
			if (inWord && /^\d$/.test(word)) {
				word = "";
				inWord = false;
			}
			flush();
			tokens.push({ type: "op", value: "redirect" });
			i++;
			if (command[i] === ">" || command[i] === "|") i++;
			if (command[i] === "&") {
				i++;
				while (i < command.length && /\d|-/.test(command[i]!)) i++;
			}
			continue;
		}
		if (c === "*" || c === "?" || c === "[" || c === "~") literal = false;
		word += c;
		inWord = true;
		i++;
	}
	flush();
	// Drop trailing separators, e.g. a final newline.
	while (tokens.length && tokens[tokens.length - 1]!.type === "op" && tokens[tokens.length - 1]!.value === ";")
		tokens.pop();
	return tokens;
}

export type Segment = { words: Word[]; redirects: number };

/** Split tokens into simple commands. Returns the separators between them too. */
export function segments(tokens: Token[]): { commands: Segment[]; separators: Operator["value"][] } {
	const commands: Segment[] = [{ words: [], redirects: 0 }];
	const separators: Operator["value"][] = [];
	for (const token of tokens) {
		if (token.type === "word") commands[commands.length - 1]!.words.push(token);
		else if (token.value === "redirect") commands[commands.length - 1]!.redirects++;
		else {
			separators.push(token.value);
			commands.push({ words: [], redirects: 0 });
		}
	}
	return { commands, separators };
}
