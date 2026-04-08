/**
 * Built-in cron jobs for the pet daemon.
 *
 * - memory-reflection: Consolidate recent reflections, prune old ones
 * - soul-evolution: Analyze accumulated knowledge to evolve persona soul
 * - session-cleanup: Archive old session records
 * - proactive-message: Send a greeting or check-in (optional)
 */

import type { CollaborationManager } from "../collaboration/manager.js";
import { spawnClaude } from "../executor/spawner.js";
import type { FeedStore } from "../knowledge-feed/feed-store.js";
import type { FeedSubscriber } from "../knowledge-feed/subscriber.js";
import { analyzeActivity } from "../memory/activity-analyzer.js";
import type { ActivityTracker } from "../memory/activity.js";
import type { ChatHistoryManager } from "../memory/history.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { PersonaManager } from "../memory/persona.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import type { ChannelPlugin } from "../plugins/types.js";
import type { SessionStore } from "../session/store.js";
import { logger } from "../utils/logger.js";
import type { CronJob } from "./service.js";

export type KnowledgeFeedDeps = {
	feedStore: FeedStore;
	feedSubscriber: FeedSubscriber;
	pollIntervalMs: number;
	ttlMs: number;
};

export type CronJobDeps = {
	persona: PersonaManager;
	knowledge: KnowledgeManager;
	reflections: ReflectionManager;
	relationships: RelationshipManager;
	sessionStore: SessionStore;
	activityTracker: ActivityTracker;
	history: ChatHistoryManager;
	collaboration?: CollaborationManager;
	knowledgeFeed?: KnowledgeFeedDeps;
	plugins: ChannelPlugin[];
};

const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export function createBuiltinJobs(deps: CronJobDeps): CronJob[] {
	return [
		{
			id: "memory-reflection",
			intervalMs: SIX_HOURS,
			runOnStart: false,
			handler: () => runMemoryReflection(deps),
		},
		{
			id: "soul-evolution",
			intervalMs: TWENTY_FOUR_HOURS,
			runOnStart: false,
			handler: () => runSoulEvolution(deps),
		},
		{
			id: "knowledge-dedup",
			intervalMs: TWELVE_HOURS,
			runOnStart: false,
			handler: () => runKnowledgeDedup(deps),
		},
		{
			id: "session-cleanup",
			intervalMs: TWENTY_FOUR_HOURS,
			runOnStart: true,
			handler: () => runSessionCleanup(deps),
		},
		{
			id: "activity-monitor",
			intervalMs: 10 * 60 * 1000, // 10 minutes
			runOnStart: false,
			handler: () => runActivityMonitor(deps),
		},
		{
			id: "history-prune",
			intervalMs: TWENTY_FOUR_HOURS,
			runOnStart: false,
			handler: () => runHistoryPrune(deps),
		},
		...(deps.collaboration
			? [
					{
						id: "collaboration-poll",
						intervalMs: 5_000, // 5 seconds
						runOnStart: false,
						handler: () => deps.collaboration!.pollAndExecute(),
					},
				]
			: []),
		...(deps.knowledgeFeed
			? [
					{
						id: "knowledge-feed-poll",
						intervalMs: deps.knowledgeFeed.pollIntervalMs,
						runOnStart: false,
						handler: () => runKnowledgeFeedPoll(deps.knowledgeFeed!),
					},
					{
						id: "knowledge-feed-cleanup",
						intervalMs: TWELVE_HOURS,
						runOnStart: false,
						handler: () => runKnowledgeFeedCleanup(deps.knowledgeFeed!),
					},
				]
			: []),
	];
}

/**
 * Memory reflection — consolidate recent reflections.
 * Reference: OpenClaw dreaming pattern.
 * Reads recent reflections and asks Claude to produce a consolidated narrative.
 */
async function runMemoryReflection(deps: CronJobDeps): Promise<void> {
	const recent = await deps.reflections.getRecent(10);
	if (recent.length < 3) {
		logger.debug("Not enough reflections for consolidation", {
			count: recent.length,
		});
		return;
	}

	const summaries = recent.map((r) => `- ${r.summary}`).join("\n");
	const prompt = [
		"아래는 최근 대화들의 요약이야. 이것들을 분석해서 공통 주제와 패턴을 찾아줘.",
		"JSON으로만 응답해 (다른 텍스트 없이):",
		'{"commonThemes": ["주제1", "주제2"], "patterns": ["패턴1"], "growth": "성장 포인트"}',
		"",
		summaries,
	].join("\n");

	const handle = spawnClaude({ prompt, model: "haiku", maxTurns: 1 });
	let result = "";
	handle.onResult((r) => {
		result = r.result;
	});
	await handle.done;

	if (result) {
		logger.info("Memory reflection completed", { resultLength: result.length });
	}
}

/**
 * Soul evolution — update persona soul based on accumulated knowledge.
 * Asks Claude to analyze all knowledge and suggest personality evolution.
 */
async function runSoulEvolution(deps: CronJobDeps): Promise<void> {
	const allKnowledge = await deps.knowledge.listAll();
	const allRelationships = await deps.relationships.listAll();

	if (allKnowledge.length < 5) {
		logger.debug("Not enough knowledge for soul evolution", {
			count: allKnowledge.length,
		});
		return;
	}

	const knowledgeSummary = allKnowledge
		.slice(-20)
		.map((k) => `- [${k.topic}] ${k.content}`)
		.join("\n");

	const relationshipSummary = allRelationships
		.map(
			(r) =>
				`- ${r.displayName}: ${r.interactionCount}회 대화, 메모: ${r.notes.slice(-3).join("; ")}`,
		)
		.join("\n");

	const prompt = [
		"너는 AI 페르소나의 자기 성찰 엔진이야.",
		"아래 지식과 관계 데이터를 분석해서 페르소나가 어떻게 성장했는지 파악해.",
		"JSON으로만 응답해:",
		'{"learnedTraits": ["새로 배운 특성"], "preferredTopics": ["관심 주제"], "communicationStyle": "소통 스타일 설명"}',
		"",
		"축적된 지식:",
		knowledgeSummary,
		"",
		"관계:",
		relationshipSummary,
	].join("\n");

	const handle = spawnClaude({ prompt, model: "haiku", maxTurns: 1 });
	let result = "";
	handle.onResult((r) => {
		result = r.result;
	});
	await handle.done;

	if (!result) return;

	try {
		const jsonMatch = result.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return;

		const parsed = JSON.parse(jsonMatch[0]) as {
			learnedTraits?: string[];
			preferredTopics?: string[];
			communicationStyle?: string;
		};

		await deps.persona.updateSoul({
			learnedTraits: parsed.learnedTraits ?? [],
			preferredTopics: parsed.preferredTopics ?? [],
			communicationStyle: parsed.communicationStyle ?? "",
		});

		logger.info("Soul evolution completed", {
			traits: parsed.learnedTraits?.length ?? 0,
			topics: parsed.preferredTopics?.length ?? 0,
		});
	} catch (err) {
		logger.warn("Soul evolution parse failed", { error: String(err) });
	}
}

/**
 * Knowledge dedup — merge duplicate or near-duplicate knowledge entries.
 */
async function runKnowledgeDedup(deps: CronJobDeps): Promise<void> {
	const all = await deps.knowledge.listAll();
	if (all.length < 2) return;

	let merged = 0;
	const keep = new Map<string, (typeof all)[0]>();
	const toDelete: string[] = [];

	for (const entry of all) {
		const topicKey = entry.topic.toLowerCase().trim();
		const existing = keep.get(topicKey);

		if (existing) {
			// Keep the one with higher confidence or more recent update
			if (
				entry.confidence > existing.confidence ||
				entry.updatedAt > existing.updatedAt
			) {
				toDelete.push(existing.id);
				keep.set(topicKey, entry);
			} else {
				toDelete.push(entry.id);
			}
			merged++;
		} else {
			keep.set(topicKey, entry);
		}
	}

	// Persist: delete the duplicates
	for (const id of toDelete) {
		await deps.knowledge.delete(id);
	}

	if (merged > 0) {
		logger.info("Knowledge dedup completed", { merged, remaining: keep.size });
	}
}

/**
 * Session cleanup — remove session records older than 30 days.
 */
async function runSessionCleanup(deps: CronJobDeps): Promise<void> {
	const keys = await deps.sessionStore.list();
	const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - THIRTY_DAYS;
	let cleaned = 0;

	for (const key of keys) {
		const record = await deps.sessionStore.read(key);
		if (record && record.lastActivityAt < cutoff) {
			await deps.sessionStore.delete(key);
			cleaned++;
		}
	}

	if (cleaned > 0) {
		logger.info("Session cleanup completed", {
			cleaned,
			remaining: keys.length - cleaned,
		});
	}
}

/**
 * Activity monitor — check active users and send proactive care messages.
 */
async function runActivityMonitor(deps: CronJobDeps): Promise<void> {
	const activeUsers = await deps.activityTracker.listActiveUsers();
	if (activeUsers.length === 0) return;

	for (const record of activeUsers) {
		const analysis = analyzeActivity(record);
		if (!analysis.shouldAlert || !analysis.suggestion) continue;

		// Find the channel to send the message
		// Use the relationship to find which channel this user is on
		const rel = await deps.relationships.get(record.userId);
		if (!rel) continue;

		// Send via first available plugin
		for (const plugin of deps.plugins) {
			try {
				// We don't know the exact channelId, but we can use a recent session
				const sessions = await deps.sessionStore.list();
				const userSession = sessions.find((k) => k.startsWith(record.userId));
				if (!userSession) continue;

				const sessionRecord = await deps.sessionStore.read(userSession);
				if (!sessionRecord) continue;

				await plugin.sendMessage(sessionRecord.channelId, analysis.suggestion);
				await deps.activityTracker.markAlerted(record.userId, Date.now());
				logger.info("Activity alert sent", {
					userId: record.userId,
					isLateNight: analysis.isLateNight,
					sessionMinutes: analysis.sessionDurationMinutes,
				});
				break; // Only send once per user
			} catch (err) {
				logger.warn("Failed to send activity alert", { error: String(err) });
			}
		}
	}
}

/**
 * History prune — remove entries older than 7 days, keep at least 500.
 */
async function runHistoryPrune(deps: CronJobDeps): Promise<void> {
	const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
	const channels = await deps.history.listChannels();
	let totalPruned = 0;

	for (const channelId of channels) {
		const pruned = await deps.history.prune(channelId, SEVEN_DAYS, 500);
		totalPruned += pruned;
	}

	if (totalPruned > 0) {
		logger.info("History prune completed", {
			pruned: totalPruned,
			channels: channels.length,
		});
	}
}

/**
 * Knowledge feed poll — import new knowledge from other pets.
 */
async function runKnowledgeFeedPoll(deps: KnowledgeFeedDeps): Promise<void> {
	const result = await deps.feedSubscriber.poll();
	if (result.imported > 0 || result.skipped > 0) {
		logger.info("Knowledge feed poll completed", {
			imported: result.imported,
			skipped: result.skipped,
		});
	}
}

/**
 * Knowledge feed cleanup — remove feed entries older than TTL.
 */
async function runKnowledgeFeedCleanup(deps: KnowledgeFeedDeps): Promise<void> {
	const expired = await deps.feedStore.findExpired(deps.ttlMs);
	let removed = 0;

	for (const entry of expired) {
		await deps.feedStore.remove(entry.id);
		removed++;
	}

	if (removed > 0) {
		logger.info("Knowledge feed cleanup completed", {
			removed,
		});
	}
}
