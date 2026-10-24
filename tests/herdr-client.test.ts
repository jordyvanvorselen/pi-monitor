import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectHerdr, FIRST_BACKOFF_MS, HerdrClient, herdrConfigPath } from "../src/herdr/client.ts";
import { fakeHerdr } from "./fake-herdr.ts";

describe("Herdr detection", () => {
	it("needs HERDR_ENV=1, a socket path and a pane id", () => {
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
		assert.deepEqual(detectHerdr(env), { socketPath: "/tmp/h.sock", paneId: "w1:p1" });
		assert.equal(detectHerdr({ ...env, HERDR_ENV: "0" }), undefined);
		assert.equal(detectHerdr({ ...env, HERDR_PANE_ID: "" }), undefined);
		assert.equal(detectHerdr({ TERM_PROGRAM: "herdr" }), undefined);
	});

	it("finds the config like Herdr: HERDR_CONFIG_PATH, then XDG_CONFIG_HOME, then ~/.config", () => {
		assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: "/x/c.toml" }, "/home/me"), "/x/c.toml");
		assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/me"), "/xdg/herdr/config.toml");
		assert.equal(herdrConfigPath({}, "/home/me"), "/home/me/.config/herdr/config.toml");
	});
});

describe("Herdr socket client", () => {
	it("sends one JSON line with id, method and params and returns the reply line", async () => {
		const herdr = await fakeHerdr(() => ({ result: { type: "pong" } }));
		const client = new HerdrClient({ socketPath: herdr.socketPath, log: () => {} });
		const reply = await client.request("ping", { a: 1 });
		assert.deepEqual(reply?.result, { type: "pong" });
		assert.equal(herdr.received[0]!.method, "ping");
		assert.deepEqual(herdr.received[0]!.params, { a: 1 });
		assert.match(herdr.received[0]!.id, /^pi-monitor:\d+:1$/);
		await herdr.close();
	});

	it("keeps requests in order, one after the other", async () => {
		const herdr = await fakeHerdr();
		const client = new HerdrClient({ socketPath: herdr.socketPath, log: () => {} });
		await Promise.all([1, 2, 3, 4].map((n) => client.request(`m${n}`, {})));
		assert.deepEqual(herdr.methods(), ["m1", "m2", "m3", "m4"]);
		await herdr.close();
	});

	it("returns Herdr's refusals without backing off and logs them", async () => {
		const herdr = await fakeHerdr(() => ({ error: { code: "pane_not_found", message: "pane x not found" } }));
		const logs: string[] = [];
		const client = new HerdrClient({ socketPath: herdr.socketPath, log: (m) => logs.push(m) });
		const reply = await client.request("pane.report_metadata", {});
		assert.equal(reply?.error?.code, "pane_not_found");
		assert.equal(client.backingOff, false);
		assert.match(logs[0]!, /refused: pane_not_found/);
		await herdr.close();
	});

	it("never throws: a missing socket resolves to undefined, is logged and makes the client wait before trying again", async () => {
		let now = 1_000;
		const logs: string[] = [];
		const client = new HerdrClient({ socketPath: "/nonexistent/herdr.sock", log: (m) => logs.push(m), now: () => now });
		assert.equal(await client.request("ping", {}), undefined);
		assert.equal(client.backingOff, true);
		assert.match(logs[0]!, /herdr: ping failed .* next try in 1s/);
		assert.equal(await client.request("ping", {}), undefined);
		assert.equal(logs.length, 1, "skipped while backing off, without another attempt");
		now += FIRST_BACKOFF_MS;
		await client.request("ping", {});
		assert.match(logs[1]!, /next try in 2s/, "the wait doubles");
	});

	it("treats a connection closed without a reply as a failure and recovers when Herdr answers again", async () => {
		const herdr = await fakeHerdr();
		let now = 1_000;
		const logs: string[] = [];
		const client = new HerdrClient({ socketPath: herdr.socketPath, log: (m) => logs.push(m), now: () => now });
		herdr.state.mode = "drop";
		assert.equal(await client.request("ping", {}), undefined);
		herdr.state.mode = "answer";
		now += FIRST_BACKOFF_MS;
		assert.ok(await client.request("ping", {}));
		assert.equal(client.backingOff, false);
		assert.match(logs.at(-1)!, /reachable again/);
		await herdr.close();
	});
});
