import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { LOOP_MS, story } from "../scripts/dock-story.ts";
import { piTheme } from "../scripts/pi-theme.ts";
import { renderRichDock } from "../src/ui/dock-rich.ts";
import { lookFor } from "../src/ui/look.ts";

const theme = piTheme("dark");
const look = lookFor(theme, { background: [16, 18, 24] })!;

function frame(ms: number, width = 110): string[] {
	const { now, items, savedTokens } = story(ms);
	return renderRichDock(
		items,
		{ width, now, frame: 0, savedTokens, shortcut: "ctrl+shift+m", reducedMotion: false },
		look,
		theme,
	);
}

const text = (ms: number) =>
	frame(ms)
		.map((l) => stripTerminalSequences(l))
		.join("\n");

describe("README recording story", () => {
	it("renders every frame of the loop at exactly the recording width", () => {
		for (let ms = 0; ms < LOOP_MS; ms += 1000 / 15)
			for (const line of frame(ms)) assert.equal(visibleWidth(line), 110, `${ms} ms: ${line}`);
	});

	it("shows the moments the README promises", () => {
		assert.match(text(4_000), /CI #42 .*test ▸ Run unit tests/);
		assert.match(text(4_000), /⏳ yarn dev .*background in/);
		assert.match(text(6_500), /CI #42 .*test ✗ Run unit tests .*pi is on it ↳/);
		assert.ok(frame(6_500)[1]!.includes("\x1b[48;2;"), "red glow behind the failing run");
		assert.match(text(13_100), /✓ CI #42 .*all 4 jobs passed/);
		assert.match(text(15_000), /✓ CI #42 green in 6m02s/);
		assert.match(text(15_000), /■ yarn dev stopped by the user/);
	});

	it("ends the loop with only the dev server, like it starts", () => {
		assert.deepEqual(
			story(LOOP_MS - 100).items.map((i) => i.id),
			["dev"],
		);
	});
});
