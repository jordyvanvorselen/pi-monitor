import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchPattern, parseDuration } from "../src/intercept/patterns.ts";
import { tokenize } from "../src/intercept/shell.ts";

describe("shell lexer", () => {
	it("splits words, quotes and operators", () => {
		assert.deepEqual(
			tokenize(`tail -f 'my app.log' | grep --line-buffered "ERROR x"`)?.map((t) => t.value),
			["tail", "-f", "my app.log", "|", "grep", "--line-buffered", "ERROR x"],
		);
		assert.deepEqual(
			tokenize("sleep 40 && echo done")?.map((t) => t.value),
			["sleep", "40", "&&", "echo", "done"],
		);
	});

	it("marks variables and globs as not literal", () => {
		const id = tokenize("gh run watch $RUN_ID")!.at(-1);
		assert.equal(id?.type === "word" && id.literal, false);
		const [, glob] = tokenize("tail *.log")!;
		assert.equal(glob?.type === "word" && glob.literal, false);
	});

	it("gives up on subshells, command substitution, backticks and here-docs", () => {
		for (const command of [
			"(cd x && make)",
			"echo $(date)",
			"echo `date`",
			"cat <<EOF\nx\nEOF",
			"{ a; b; }",
			"echo 'open",
		])
			assert.equal(tokenize(command), undefined, command);
	});

	it("treats redirects as operators", () => {
		assert.deepEqual(
			tokenize("make 2>&1 > out.txt")?.map((t) => t.value),
			["make", "redirect", "redirect", "out.txt"],
		);
	});
});

describe("blocking-wait patterns", () => {
	it("parses durations with units", () => {
		assert.equal(parseDuration("40"), 40);
		assert.equal(parseDuration("1.5m"), 90);
		assert.equal(parseDuration("2h"), 7200);
		assert.equal(parseDuration("x"), undefined);
	});

	it("recognises gh run watch with an id, a repo or no id", () => {
		assert.deepEqual(matchPattern("gh run watch 123 --exit-status"), { kind: "gh_run", target: "123" });
		assert.deepEqual(matchPattern("gh run watch"), { kind: "gh_run", target: "latest" });
		assert.deepEqual(matchPattern("gh run watch 9 -R acme/app -i 10"), {
			kind: "gh_run",
			target: "https://github.com/acme/app/actions/runs/9",
		});
	});

	it("recognises gh pr checks --watch", () => {
		assert.deepEqual(matchPattern("gh pr checks 42 --watch"), { kind: "gh_pr", target: "42" });
		assert.deepEqual(matchPattern("gh pr checks --watch --fail-fast"), { kind: "gh_pr", target: "" });
		assert.deepEqual(matchPattern("gh pr checks 42 --watch --repo acme/app"), {
			kind: "gh_pr",
			target: "https://github.com/acme/app/pull/42",
		});
	});

	it("turns long sleeps, alone or followed by one command, into a timer", () => {
		assert.deepEqual(matchPattern("sleep 40 && echo done"), { kind: "timer", seconds: 40, then: "echo done" });
		assert.deepEqual(matchPattern("sleep 2m"), { kind: "timer", seconds: 120 });
		assert.deepEqual(matchPattern("sleep 1m 30 && gh run view 5"), {
			kind: "timer",
			seconds: 90,
			then: "gh run view 5",
		});
	});

	it("recognises tail -f, optionally piped through a simple grep", () => {
		assert.deepEqual(matchPattern("tail -f app.log"), { kind: "file", path: "app.log" });
		assert.deepEqual(matchPattern("tail -n 0 -F /var/log/x.log | grep --line-buffered ERROR"), {
			kind: "file",
			path: "/var/log/x.log",
			match: "ERROR",
		});
		assert.deepEqual(matchPattern("tail -f app.log | grep -E 'ERROR|WARN'"), {
			kind: "file",
			path: "app.log",
			match: "ERROR|WARN",
		});
	});

	it("leaves ambiguous or unfamiliar commands alone", () => {
		for (const command of [
			"sleep 20 && echo ok",
			"sleep 5",
			"sleep 40; echo done",
			"sleep 40 && echo a && echo b",
			"sleep 40 && echo done > out.txt",
			"gh run watch $ID",
			"gh run watch 1 && echo done",
			"gh run watch abc",
			"gh run watch 1 --unknown-flag",
			"gh pr checks 42",
			"tail app.log",
			"tail -f a.log b.log",
			"tail -f app.log | grep -i error",
			"tail -f app.log | grep -v debug",
			"tail -f app.log | grep 'a.*b'",
			"tail -f app.log | grep ERROR | head",
			"tail -f *.log",
			"(sleep 40 && echo done)",
			"echo $(sleep 40)",
			"npm run dev",
		])
			assert.equal(matchPattern(command), undefined, command);
	});
});
