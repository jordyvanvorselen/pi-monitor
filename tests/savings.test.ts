import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pollingCost, savedTokens } from "../src/savings.ts";

describe("token savings estimate", () => {
	it("counts one 200-token poll per full 30 seconds of watching", () => {
		assert.equal(pollingCost(10_000), 0);
		assert.equal(pollingCost(30_000), 200);
		assert.equal(pollingCost(20 * 60_000), 8_000);
	});

	it("subtracts the tokens the monitor delivered and never goes below zero", () => {
		assert.equal(savedTokens(20 * 60_000, 80), 7_920);
		assert.equal(savedTokens(10_000, 80), 0);
	});
});
