import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Delivery,
	wakes,
	type OutgoingMessage,
	type SendOptions,
	type Target,
	type WakeLevel,
} from "../src/delivery.ts";
import { FakeClock } from "./helpers.ts";

function setup(wake: WakeLevel = "final", idle = true) {
	const clock = new FakeClock();
	const sent: { message: OutgoingMessage; options: SendOptions }[] = [];
	const paused: string[] = [];
	const state = { idle };
	const delivery = new Delivery({
		send: (message, options) => sent.push({ message, options }),
		isIdle: () => state.idle,
		clock,
		onPause: (id) => paused.push(id),
	});
	const target: Target = { id: "m1", description: "CI", wake, logPath: "/tmp/m1.log" };
	return { clock, sent, paused, state, delivery, target };
}

describe("wake levels", () => {
	it("final wakes only on failures, events also on notable lines, never stays silent", () => {
		assert.equal(wakes("final", "notable"), false);
		assert.equal(wakes("final", "failure"), true);
		assert.equal(wakes("events", "notable"), true);
		assert.equal(wakes("events", "progress"), false);
		assert.equal(wakes("never", "failure"), false);
	});
});

describe("delivery", () => {
	it("triggers a turn when Pi is idle", () => {
		const { sent, delivery, target } = setup();
		delivery.final(target, { status: "success", summary: "CI #42 green in 6m02s" });
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
		assert.match(sent[0]!.message.content, /^\[monitor m1 "CI"\] SUCCEEDED: CI #42 green in 6m02s/);
		assert.equal(sent[0]!.message.customType, "monitor");
		assert.equal(sent[0]!.message.details.kind, "final");
	});

	it("queues a follow-up when Pi is busy", () => {
		const { sent, delivery, target } = setup("final", false);
		delivery.final(target, { status: "success", summary: "ok" });
		assert.equal(sent[0]!.options.deliverAs, "followUp");
	});

	it("steers when a failure arrives while Pi is busy", () => {
		const { sent, delivery, target } = setup("final", false);
		delivery.event(target, { text: 'job "test" failed', level: "failure", detail: ["boom"] });
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.options.deliverAs, "steer");
		assert.match(sent[0]!.message.content, /boom/);
	});

	it("does not wake for progress or notable events under final", () => {
		const { sent, delivery, target, clock } = setup("final");
		delivery.event(target, { text: "job started", level: "progress" });
		delivery.event(target, { text: "job passed", level: "notable" });
		clock.advance(1000);
		assert.equal(sent.length, 0);
	});

	it("never wakes for anything under never, not even failures or the end", () => {
		const { sent, delivery, target } = setup("never");
		delivery.event(target, { text: "boom", level: "failure" });
		delivery.final(target, { status: "failure", summary: "exit 1" });
		assert.equal(sent.length, 0);
	});

	it("stays silent when the monitor was stopped on purpose", () => {
		const { sent, delivery, target } = setup("events");
		delivery.final(target, { status: "stopped", summary: "stopped" });
		assert.equal(sent.length, 0);
	});

	it("batches lines that arrive within 500 ms into one message", () => {
		const { sent, delivery, target, clock } = setup("events");
		delivery.event(target, { text: "error: a", level: "notable" });
		clock.advance(200);
		delivery.event(target, { text: "error: b", level: "notable" });
		assert.equal(sent.length, 0);
		clock.advance(300);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.message.content, /2 new lines\n {2}error: a\n {2}error: b\n {2}log: \/tmp\/m1\.log/);
	});

	it("sends a single batched line as the headline", () => {
		const { sent, delivery, target, clock } = setup("events");
		delivery.event(target, { text: "ready on :3000", level: "notable" });
		clock.advance(500);
		assert.equal(sent[0]!.message.content, '[monitor m1 "CI"] ready on :3000\n  log: /tmp/m1.log');
	});

	it("caps a batch at 20 lines and counts the rest", () => {
		const { sent, delivery, target, clock } = setup("events");
		for (let i = 0; i < 25; i++) delivery.event(target, { text: `line ${i}`, level: "notable" });
		clock.advance(500);
		const content = sent[0]!.message.content;
		assert.match(content, /25 new lines/);
		assert.match(content, /line 19/);
		assert.doesNotMatch(content, /line 20/);
		assert.match(content, /… 5 more lines: \/tmp\/m1\.log/);
	});

	it("collapses repeated lines in a batch", () => {
		const { sent, delivery, target, clock } = setup("events");
		for (let i = 0; i < 37; i++) delivery.event(target, { text: "Waiting for job…", level: "notable" });
		delivery.event(target, { text: "done", level: "notable" });
		clock.advance(500);
		assert.match(sent[0]!.message.content, /\(×20\) Waiting for job…/);
	});

	it("flushes pending lines before the final message", () => {
		const { sent, delivery, target } = setup("events");
		delivery.event(target, { text: "compiling", level: "notable" });
		delivery.final(target, { status: "failure", summary: "exited with code 2 after 3s" });
		assert.equal(sent.length, 2);
		assert.match(sent[0]!.message.content, /compiling/);
		assert.match(sent[1]!.message.content, /FAILED: exited with code 2/);
	});

	it("pauses a monitor that sends more than 10 wake messages in a minute and says so once", () => {
		const { sent, delivery, target, clock, paused } = setup("events");
		for (let i = 0; i < 15; i++) {
			delivery.event(target, { text: `burst ${i}`, level: "notable" });
			clock.advance(600);
		}
		assert.equal(sent.length, 11);
		assert.equal(sent[10]!.message.details.kind, "noisy");
		assert.match(sent[10]!.message.content, /m1 is too noisy\. .*Tighten `match` or use `wake: final`/);
		assert.deepEqual(paused, ["m1"]);
		assert.equal(delivery.isPaused("m1"), true);
	});

	it("still delivers the final message of a paused monitor", () => {
		const { sent, delivery, target, clock } = setup("events");
		for (let i = 0; i < 12; i++) {
			delivery.event(target, { text: `burst ${i}`, level: "notable" });
			clock.advance(600);
		}
		const before = sent.length;
		delivery.final(target, { status: "success", summary: "done" });
		assert.equal(sent.length, before + 1);
	});

	it("allows wakes again after the flood window passes", () => {
		const { sent, delivery, target, clock } = setup("events");
		for (let i = 0; i < 10; i++) {
			delivery.event(target, { text: `burst ${i}`, level: "notable" });
			clock.advance(600);
		}
		clock.advance(60_000);
		delivery.event(target, { text: "later", level: "notable" });
		clock.advance(600);
		assert.equal(sent.length, 11);
		assert.equal(sent[10]!.message.details.kind, "event");
	});

	it("dispose clears pending batch timers", () => {
		const { delivery, target, clock, sent } = setup("events");
		delivery.event(target, { text: "x", level: "notable" });
		delivery.dispose();
		assert.equal(clock.pending(), 0);
		clock.advance(1000);
		assert.equal(sent.length, 0);
	});
});
