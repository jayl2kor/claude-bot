/**
 * Types for smart model selection.
 * Maps message complexity to Claude model tiers (haiku/sonnet/opus).
 */

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ClassificationResult {
	tier: ModelTier;
	confidence: number;
	reason: string;
	isOverride: boolean;
}

export interface ClassificationContext {
	userId: string;
	channelId: string;
	timestamp: number;
	previousModel?: ModelTier;
	previousTimestamp?: number;
}

export interface DailyModelStats {
	date: string;
	haiku: { count: number };
	sonnet: { count: number };
	opus: { count: number };
	overrideCount: number;
}
