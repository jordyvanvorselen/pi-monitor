import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockingWaitReason } from "../src/guard.ts";
import { harness } from "./harness.ts";

describe("blocking-wait guard", () => {
	it("blocks gh run watch and suggests a gh_run monitor with the same id", () => {
		const reason = blockingWaitReason("gh run watch 123456 --exit-status");
		assert.match(reason!, /gh_run: "123456"/);
		assert.match(blockingWaitReason("gh run watch")!, /gh_run: "latest"/);
	});

	it("blocks gh pr checks --watch and suggests a gh_pr monitor", () => {
		assert.match(blockingWaitReason("gh pr checks 42 --watch")!, /gh_pr: "42"/);
		assert.equal(blockingWaitReason("gh pr checks 42"), undefined);
	});

	it("blocks sleep over 20 seconds, with units and sums", () => {
		assert.match(blockingWaitReason("sleep 1m 30")!, /sleeping 90s/);
		assert.match(blockingWaitReason("sleep 0.5h")!, /sleeping 1800s/);
		assert.equal(blockingWaitReason("for i in 1 2; do sleep 5; done"), undefined);
		assert.match(blockingWaitReason("sleep 60 && gh run view 123")!, /sleeping 60s/);
		assert.equal(blockingWaitReason("sleep 20"), undefined);
		assert.equal(blockingWaitReason("sleep 2; curl localhost"), undefined);
	});

	it("ignores words that only contain sleep", () => {
		assert.equal(blockingWaitReason("npm run sleepy-test 100"), undefined);
		assert.equal(blockingWaitReason("echo nosleep 30"), undefined);
	});

	it("keeps the reason short, about 50 tokens", () => {
		for (const command of ["gh run watch 1", "gh pr checks 1 --watch", "sleep 300"])
			assert.ok(blockingWaitReason(command)!.length / 4 < 70);
	});

	it("is wired to bash tool calls and can be turned off in settings", async () => {
		const on = harness();
		await on.fire("session_start", { reason: "startup" });
		const blocked = await on.fire("tool_call", { toolName: "bash", toolCallId: "t", input: { command: "sleep 120" } });
		assert.equal(blocked?.block, true);
		const other = await on.fire("tool_call", { toolName: "read", toolCallId: "t", input: { path: "sleep 120" } });
		assert.equal(other, undefined);

		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const off = harness();
		mkdirSync(join(off.cwd, ".pi"), { recursive: true });
		writeFileSync(join(off.cwd, ".pi", "settings.json"), JSON.stringify({ monitor: { blockBlockingWaits: false } }));
		await off.fire("session_start", { reason: "startup" });
		assert.equal(
			await off.fire("tool_call", { toolName: "bash", toolCallId: "t", input: { command: "sleep 120" } }),
			undefined,
		);
	});
});
