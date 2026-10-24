import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Received {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

/**
 * A Herdr socket for tests: reads one JSON line per connection and answers with `reply`.
 * `mode` "drop" closes connections without a reply, like a Herdr that is going away.
 */
export async function fakeHerdr(
	reply: (request: Received) => Record<string, unknown> = (request) =>
		request.method === "server.reload_config"
			? { result: { type: "config_reload", status: "applied", diagnostics: [] } }
			: { result: { type: "ok" } },
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-herdr-"));
	const socketPath = join(dir, "herdr.sock");
	const received: Received[] = [];
	const state = { mode: "answer" as "answer" | "drop", connections: 0 };
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		state.connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		if (state.mode === "drop") return void socket.end();
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const request = JSON.parse(buffer.slice(0, end)) as Received;
			received.push(request);
			socket.write(`${JSON.stringify({ id: request.id, ...reply(request) })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	// A test that fails before close() must not keep the test process alive.
	server.unref();
	return {
		socketPath,
		received,
		state,
		methods: () => received.map((r) => r.method),
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
