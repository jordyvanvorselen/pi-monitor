/**
 * Token savings estimate.
 *
 * Without a monitor the model would poll: `sleep 30 && gh run view …` in bash, read the result,
 * decide to poll again. We count one poll per full 30 seconds of watched time at about 200 tokens
 * (≈50 tokens for the tool call, ≈150 for a trimmed result). That ignores re-reading the growing
 * context on every poll, so the real saving is larger. Savings = that cost − tokens we delivered.
 */
export const POLL_INTERVAL_MS = 30_000;
export const TOKENS_PER_POLL = 200;

export function pollingCost(durationMs: number): number {
	return Math.floor(Math.max(0, durationMs) / POLL_INTERVAL_MS) * TOKENS_PER_POLL;
}

export function savedTokens(durationMs: number, deliveredTokens: number): number {
	return Math.max(0, pollingCost(durationMs) - deliveredTokens);
}
