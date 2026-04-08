/**
 * Types for the growth report feature.
 * Covers aggregated stats, generated reports, and report history.
 */

import { z } from "zod";

/** Aggregated stats for a report period. */
export type GrowthStats = {
	readonly period: {
		readonly startAt: number;
		readonly endAt: number;
	};
	readonly conversations: {
		readonly totalCount: number;
		readonly uniqueUsers: number;
		readonly newRelationships: number;
	};
	readonly knowledge: {
		readonly newCount: number;
		readonly totalCount: number;
		readonly mainTopics: readonly string[];
	};
	readonly soul: {
		readonly newTraits: readonly string[];
		readonly preferredTopics: readonly string[];
		readonly communicationStyle: string;
	};
	readonly activity: {
		readonly peakHours: readonly number[];
		readonly totalSessions: number;
	};
	readonly reflections: {
		readonly count: number;
		readonly highlights: readonly string[];
	};
};

/** Delta comparison between current and previous stats. */
export type GrowthDelta = {
	readonly conversationsDelta: number;
	readonly uniqueUsersDelta: number;
	readonly knowledgeDelta: number;
	readonly newRelationshipsDelta: number;
};

/** A generated growth report. */
export type GrowthReport = {
	readonly id: string;
	readonly generatedAt: number;
	readonly periodStart: number;
	readonly periodEnd: number;
	readonly stats: GrowthStats;
	readonly delta: GrowthDelta | null;
	readonly reportText: string;
};

/** Persisted report history for delta comparison. */
export const ReportHistorySchema = z.object({
	id: z.string(),
	generatedAt: z.number(),
	periodStart: z.number(),
	periodEnd: z.number(),
	conversationCount: z.number(),
	uniqueUsers: z.number(),
	knowledgeCount: z.number(),
	relationshipCount: z.number(),
	reportText: z.string(),
});

export type ReportHistory = z.output<typeof ReportHistorySchema>;
