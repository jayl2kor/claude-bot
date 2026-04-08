/**
 * Growth data collector — aggregates stats from all memory stores.
 *
 * Collects conversation counts, knowledge growth, soul evolution,
 * activity patterns, and reflection highlights for a given period.
 */

import type { ActivityTracker } from "../memory/activity.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { PersonaManager } from "../memory/persona.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import type { SessionStore } from "../session/store.js";
import type { GrowthDelta, GrowthStats, ReportHistory } from "./types.js";

export type CollectorDeps = {
	readonly knowledge: Pick<KnowledgeManager, "listAll">;
	readonly relationships: Pick<RelationshipManager, "listAll">;
	readonly reflections: Pick<ReflectionManager, "getRecent">;
	readonly sessionStore: Pick<SessionStore, "list" | "read">;
	readonly activityTracker: Pick<ActivityTracker, "listActiveUsers">;
	readonly persona: Pick<PersonaManager, "getPersona">;
};

const TOP_PEAK_HOURS = 3;
const RECENT_REFLECTIONS_LIMIT = 20;
const MAX_HIGHLIGHTS = 5;
const MAX_TOPICS = 10;

export class GrowthCollector {
	private readonly deps: CollectorDeps;

	constructor(deps: CollectorDeps) {
		this.deps = deps;
	}

	/** Aggregate stats from all stores for the given period. */
	async collect(periodStart: number, periodEnd: number): Promise<GrowthStats> {
		const [
			allKnowledge,
			allRelationships,
			recentReflections,
			sessionKeys,
			activityRecords,
			persona,
		] = await Promise.all([
			this.deps.knowledge.listAll(),
			this.deps.relationships.listAll(),
			this.deps.reflections.getRecent(RECENT_REFLECTIONS_LIMIT),
			this.deps.sessionStore.list(),
			this.deps.activityTracker.listActiveUsers(),
			this.deps.persona.getPersona(),
		]);

		// Sessions within period
		const sessionRecords = await Promise.all(
			sessionKeys.map((key) => this.deps.sessionStore.read(key)),
		);
		const periodSessions = sessionRecords.filter(
			(r) =>
				r !== null && r.createdAt >= periodStart && r.createdAt <= periodEnd,
		);

		const totalMessageCount = periodSessions.reduce(
			(sum, s) => sum + (s?.messageCount ?? 0),
			0,
		);

		const uniqueUserIds = new Set(
			periodSessions.map((s) => s?.userId).filter(Boolean),
		);

		// New relationships: firstSeen within period
		const newRelationships = allRelationships.filter(
			(r) => r.firstSeen >= periodStart && r.firstSeen <= periodEnd,
		);

		// Knowledge within period
		const periodKnowledge = allKnowledge.filter(
			(k) => k.createdAt >= periodStart && k.createdAt <= periodEnd,
		);
		const mainTopics = periodKnowledge.map((k) => k.topic).slice(0, MAX_TOPICS);

		// Reflections within period
		const periodReflections = recentReflections.filter(
			(r) => r.createdAt >= periodStart && r.createdAt <= periodEnd,
		);
		const highlights = periodReflections
			.map((r) => r.summary)
			.slice(0, MAX_HIGHLIGHTS);

		// Activity: aggregate hourly distributions across all tracked users
		const aggregatedHourly = Array(24).fill(0) as number[];
		for (const record of activityRecords) {
			for (let h = 0; h < 24; h++) {
				aggregatedHourly[h] += record.hourlyDistribution[h] ?? 0;
			}
		}
		const peakHours = computePeakHours(aggregatedHourly, TOP_PEAK_HOURS);

		return {
			period: { startAt: periodStart, endAt: periodEnd },
			conversations: {
				totalCount: totalMessageCount,
				uniqueUsers: uniqueUserIds.size,
				newRelationships: newRelationships.length,
			},
			knowledge: {
				newCount: periodKnowledge.length,
				totalCount: allKnowledge.length,
				mainTopics,
			},
			soul: {
				newTraits: [...persona.learnedTraits],
				preferredTopics: [...persona.preferredTopics],
				communicationStyle: persona.communicationStyle,
			},
			activity: {
				peakHours,
				totalSessions: periodSessions.length,
			},
			reflections: {
				count: periodReflections.length,
				highlights,
			},
		};
	}

	/** Compute delta between current stats and previous report history. */
	static computeDelta(
		stats: GrowthStats,
		previous: ReportHistory | null,
	): GrowthDelta | null {
		if (!previous) return null;

		return {
			conversationsDelta:
				stats.conversations.totalCount - previous.conversationCount,
			uniqueUsersDelta: stats.conversations.uniqueUsers - previous.uniqueUsers,
			knowledgeDelta: stats.knowledge.totalCount - previous.knowledgeCount,
			newRelationshipsDelta:
				stats.conversations.newRelationships - previous.relationshipCount,
		};
	}
}

/** Find the top N peak hours by activity count. */
function computePeakHours(hourly: number[], topN: number): number[] {
	return hourly
		.map((count, hour) => ({ hour, count }))
		.filter(({ count }) => count > 0)
		.sort((a, b) => b.count - a.count)
		.slice(0, topN)
		.map(({ hour }) => hour);
}
