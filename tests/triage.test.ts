import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandClassifier, isObviouslyShort, keywordGuess, type ClassifierRegistry } from "../src/intercept/triage.ts";

type Answer = { choice?: string; confidence?: number; stopReason?: string; delayMs?: number; throws?: boolean };

/** Fake `ctx.modelRegistry`: answers from a function and records calls. */
export function fakeClassifierRegistry(
	answer: (command: string) => Answer,
	models = [{ provider: "typesafe", id: "jev-latest" }],
) {
	const calls: { model: unknown; state: Record<string, unknown>; signal?: AbortSignal }[] = [];
	const registry: ClassifierRegistry = {
		getAvailableOfType: async () => models,
		classify: async (model, context, options) => {
			const command = String(context.state.command);
			calls.push({ model, state: context.state, ...(options?.signal ? { signal: options.signal } : {}) });
			const a = answer(command);
			if (a.throws) throw new Error("boom");
			if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
			return {
				answers: { runtime: { type: "choice", choice: a.choice ?? "short", confidence: a.confidence ?? 0.9 } },
				stopReason: a.stopReason ?? "stop",
				...(a.stopReason === "error" ? { errorMessage: "provider down" } : {}),
			};
		},
	};
	return { registry, calls };
}

describe("obviously short commands", () => {
	it("accepts quick commands and pipelines of them", () => {
		for (const command of [
			"ls -la",
			"git status",
			"git log --oneline | head -20",
			"rg TODO src | wc -l",
			"cat package.json | jq .version",
			"cd src && ls",
			"node -e 'console.log(1)'",
		])
			assert.equal(isObviouslyShort(command), true, command);
	});

	it("rejects test runners, followers and anything unparseable", () => {
		for (const command of [
			"npm test",
			"git push",
			"tail -f app.log",
			"node server.js",
			"python app.py",
			"ls $(pwd)",
			"cd app && npm run dev",
			"less README.md",
		])
			assert.equal(isObviouslyShort(command), false, command);
	});
});

describe("keyword guess without a classifier", () => {
	it("calls likely long commands unsure and the rest short", () => {
		for (const command of [
			"npm run dev",
			"pnpm start",
			"docker compose up",
			"kubectl logs -f pod/x",
			"vite --port 3000",
			"python -m http.server",
			"./deploy.sh production",
			"tsc --watch",
		])
			assert.equal(keywordGuess(command), "unsure", command);
		for (const command of ["npm test", "make build", "cargo check", "./run-migrations.sh"])
			assert.equal(keywordGuess(command), "short", command);
	});
});

describe("classifier triage", () => {
	it("returns the classifier's choice and sends command, cwd and the assistant text", async () => {
		const { registry, calls } = fakeClassifierRegistry((c) => ({
			choice: c === "npm run dev" ? "background" : "short",
		}));
		const classifier = new CommandClassifier(registry);
		assert.equal(
			await classifier.classify("npm run dev", { cwd: "/repo", assistant: "Starting the server." }),
			"background",
		);
		assert.equal(await classifier.classify("make", { cwd: "/repo" }), "short");
		assert.deepEqual(calls[0]!.state, {
			command: "npm run dev",
			cwd: "/repo",
			assistant_message: "Starting the server.",
		});
		assert.ok(calls[0]!.signal, "passes an abort signal");
	});

	it("caches answers per exact command", async () => {
		const { registry, calls } = fakeClassifierRegistry(() => ({ choice: "background" }));
		const classifier = new CommandClassifier(registry);
		await classifier.classify("npm run dev", { cwd: "/" });
		await classifier.classify("npm run dev", { cwd: "/" });
		await classifier.classify("npm run dev ", { cwd: "/" });
		assert.equal(calls.length, 2);
	});

	it("treats unsure, low confidence, errors, exceptions and timeouts as unsure", async () => {
		const cases: Answer[] = [
			{ choice: "unsure" },
			{ choice: "background", confidence: 0.4 },
			{ stopReason: "error" },
			{ throws: true },
			{ choice: "short", delayMs: 300 },
		];
		for (const answer of cases) {
			const { registry } = fakeClassifierRegistry(() => answer);
			const classifier = new CommandClassifier(registry, undefined, 100);
			assert.equal(await classifier.classify("x", { cwd: "/" }), "unsure", JSON.stringify(answer));
		}
	});

	it("does not cache errors, so the next call asks again", async () => {
		let fail = true;
		const { registry, calls } = fakeClassifierRegistry(() => (fail ? { stopReason: "error" } : { choice: "short" }));
		const classifier = new CommandClassifier(registry);
		assert.equal(await classifier.classify("x", { cwd: "/" }), "unsure");
		fail = false;
		assert.equal(await classifier.classify("x", { cwd: "/" }), "short");
		assert.equal(calls.length, 2);
	});

	it("uses the pinned classifier, or none when the pin is not available", async () => {
		const models = [
			{ provider: "typesafe", id: "jev-latest" },
			{ provider: "openai", id: "gpt-6-luna" },
		];
		const { registry, calls } = fakeClassifierRegistry(() => ({ choice: "short" }), models);
		assert.deepEqual(await new CommandClassifier(registry, "openai/gpt-6-luna").available(), models[1]);
		assert.deepEqual(await new CommandClassifier(registry).available(), models[0]);
		const missing = new CommandClassifier(registry, "acme/none");
		assert.equal(await missing.available(), undefined);
		assert.equal(await missing.classify("x", { cwd: "/" }), "unsure");
		assert.equal(calls.length, 0);
	});
});
