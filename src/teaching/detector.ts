/**
 * Teaching intent detector.
 *
 * NOTE: Regex-based detection has been replaced by LLM-based universal learning
 * in SessionIntegrator (integrator.ts). This file is retained as a no-op so
 * existing imports continue to compile. The integrator now runs after every
 * session and uses Claude (haiku) to extract learnings from the full conversation.
 *
 * Only the type definition is kept for backward compatibility with extractor.ts.
 */

export type TeachingIntent = {
	type: "explicit" | "correction" | "preference";
	/** The raw text that triggered detection. */
	trigger: string;
	/** Extracted payload (the thing to remember). */
	payload: string;
	/** Confidence 0-1. */
	confidence: number;
};

/**
 * @deprecated Regex-based detection is no longer used.
 * Teaching/learning is now handled by LLM in SessionIntegrator.
 * Always returns an empty array.
 */
export function detectTeaching(_text: string): TeachingIntent[] {
	return [];
}
