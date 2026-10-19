import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	cleanLine,
	collapseRepeats,
	estimateTokens,
	excerpt,
	formatDuration,
	formatEvent,
	formatShortDuration,
	formatTokens,
	stripAnsi,
} from "../src/format.ts";

describe("format", () => {
	it("strips ANSI colors and OSC hyperlinks", () => {
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07"), "red link");
	});

	it("removes gh --log-failed prefixes and timestamps", () => {
		const line = "test\tRun unit tests\t2024-05-01T12:00:03.1234567Z \x1b[31m✗ loads rules lazily\x1b[0m";
		assert.equal(cleanLine(line), "✗ loads rules lazily");
		assert.equal(cleanLine("2024-05-01T12:00:03.1234567Z plain"), "plain");
		assert.equal(
			cleanLine("##[error]Process completed with exit code 1."),
			"error: Process completed with exit code 1.",
		);
		assert.equal(cleanLine("##[group]Run npm test"), "Run npm test");
	});

	it("collapses runs of identical lines with a count", () => {
		assert.deepEqual(collapseRepeats(["a", "wait", "wait", "wait", "b", "b"]), ["a", "(×3) wait", "(×2) b"]);
	});

	it("keeps the cleaned tail of a log excerpt and counts what it dropped", () => {
		const raw = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const { lines, dropped } = excerpt(["", ...raw], 30);
		assert.equal(lines.length, 30);
		assert.equal(lines[0], "line 20");
		assert.equal(dropped, 20);
	});

	it("formats durations for messages and for narrow UI", () => {
		assert.equal(formatDuration(42_000), "42s");
		assert.equal(formatDuration(372_000), "6m12s");
		assert.equal(formatDuration(3_780_000), "1h03m");
		assert.equal(formatShortDuration(42_000), "42s");
		assert.equal(formatShortDuration(250_000), "4m");
		assert.equal(formatShortDuration(3_900_000), "1h05");
	});

	it("formats token counts compactly", () => {
		assert.equal(formatTokens(850), "850");
		assert.equal(formatTokens(6_200), "6.2k");
		assert.equal(formatTokens(240_000), "240k");
	});

	it("renders an event with header, context, body and log pointer", () => {
		const text = formatEvent({
			id: "m3",
			description: "CI for PR #42",
			headline: "failed after 6m12s",
			context: 'job "test" step "Run unit tests" failed:',
			lines: ["✗ extension.test.ts > loads rules lazily"],
			dropped: 214,
			logPath: "/tmp/pi-monitor/m3.log",
		});
		assert.equal(
			text,
			[
				'[monitor m3 "CI for PR #42"] failed after 6m12s',
				'job "test" step "Run unit tests" failed:',
				"  ✗ extension.test.ts > loads rules lazily",
				"log (214 more lines): /tmp/pi-monitor/m3.log",
			].join("\n"),
		);
	});

	it("caps an event near the token budget by dropping body lines from the top", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `a fairly long log line number ${i} with some padding text`);
		const text = formatEvent({ id: "m1", description: "x", headline: "FAILED", lines, logPath: "/tmp/m1.log" }, 400);
		assert.ok(estimateTokens(text) <= 400, `got ${estimateTokens(text)} tokens`);
		assert.match(text, /line number 199/);
		assert.match(text, /^log \(\d+ more lines\): \/tmp\/m1\.log$/m);
		assert.doesNotMatch(text, /line number 0 /);
	});
});
