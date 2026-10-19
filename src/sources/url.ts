import { formatDuration } from "../format.ts";
import type { Source } from "./types.ts";

export type Fetcher = (url: string, init: { signal: AbortSignal; method: string }) => Promise<{ status: number }>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, { ...init, redirect: "follow" });

/** Backoff: 2 s for the first 30 s, then 5 s, then 10 s after two minutes. */
export function urlDelay(elapsedMs: number): number {
	if (elapsedMs < 30_000) return 2_000;
	if (elapsedMs < 120_000) return 5_000;
	return 10_000;
}

/** Waits until a URL answers 2xx. */
export function urlSource(url: string, fetcher: Fetcher = defaultFetcher): Source {
	try {
		new URL(url);
	} catch (error) {
		throw new Error(`url is not a valid URL: ${url}`, { cause: error });
	}
	return {
		kind: "url",
		label: url,
		async start(ctx) {
			const started = ctx.now();
			let last = "";
			while (!ctx.signal.aborted) {
				let state: string;
				try {
					const response = await fetcher(url, {
						method: "GET",
						signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
					});
					if (response.status >= 200 && response.status < 300)
						return {
							status: "success",
							summary: `${url} answered ${response.status} after ${formatDuration(ctx.now() - started)}`,
						};
					state = `HTTP ${response.status}`;
				} catch (error) {
					if (ctx.signal.aborted) break;
					state = (error as Error).name === "TimeoutError" ? "no answer in 10s" : "connection failed";
				}
				if (state !== last) {
					last = state;
					ctx.line(state);
				}
				await ctx.sleep(urlDelay(ctx.now() - started));
			}
			return { status: "stopped", summary: "stopped" };
		},
	};
}
