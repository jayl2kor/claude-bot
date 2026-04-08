/**
 * Shared token estimation and budget truncation utilities.
 * Used by context/builder.ts, expertise/defer.ts, and expertise/loader.ts.
 */

/** Rough token estimate: ~4 chars per token for English, ~2 for Korean. */
export function estimateTokens(text: string): number {
	const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;
	const otherChars = text.length - koreanChars;
	return Math.ceil(koreanChars / 2 + otherChars / 4);
}

/** Truncate text to fit within a token budget. */
export function truncateToTokenBudget(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;

	// Binary search for the right cutoff
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(text.slice(0, mid)) <= budget) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return `${text.slice(0, lo)}...`;
}
