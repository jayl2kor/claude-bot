/**
 * Tests for GrowthCollector — covers:
 * - Aggregating stats from all memory stores
 * - Period filtering (only include data within the period)
 * - Delta calculation against previous report
 * - Edge cases: empty stores, no previous report
 */

import { describe, expect, it } from "vitest";
import type { ActivityRecord } from "../memory/activity.js";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import type { PersonaSoul } from "../memory/persona.js";
import type { Reflection } from "../memory/reflection.js";
import type { Relationship } from "../memory/relationships.js";
import type { SessionRecord } from "../session/store.js";
import { GrowthCollector } from "./collector.js";
import type { ReportHistory } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — create in-memory fakes matching the interfaces the collector uses
// ---------------------------------------------------------------------------

function makeKnowledgeManager(entries: KnowledgeEntry[]) {
	return { listAll: async () => entries };
}

function makeRelationshipManager(entries: Relationship[]) {
	return { listAll: async () => entries };
}

function makeReflectionManager(entries: Reflection[]) {
	return { getRecent: async (limit: number) => entries.slice(0, limit) };
}

function makeSessionStore(records: SessionRecord[]) {
	return {
		list: async () => records.map((r) => r.sessionId),
		read: async (key: string) =>
			records.find((r) => r.sessionId === key) ?? null,
	};
}

function makeActivityTracker(records: ActivityRecord[]) {
	return {
		listActiveUsers: async () => records,
	};
}

function makePersonaManager(soul: Partial<PersonaSoul> = {}) {
	return {
		getPersona: async () => ({
			name: "TestPet",
			personality: "friendly",
			tone: "casual" as const,
			values: [],
			constraints: [],
			learnedTraits: soul.learnedTraits ?? [],
			preferredTopics: soul.preferredTopics ?? [],
			communicationStyle: soul.communicationStyle ?? "",
		}),
	};
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const ONE_DAY = 24 * 60 * 60 * 1000;
const ONE_WEEK = 7 * ONE_DAY;

function daysAgo(n: number): number {
	return NOW - n * ONE_DAY;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GrowthCollector.collect", () => {
	it("aggregates stats from all stores within the period", async () => {
		const periodStart = daysAgo(7);
		const periodEnd = NOW;

		const collector = new GrowthCollector({
			knowledge: makeKnowledgeManager([
				{
					id: "k1",
					topic: "TypeScript",
					content: "TS is great",
					source: "taught",
					createdAt: daysAgo(3),
					updatedAt: daysAgo(3),
					confidence: 0.9,
					tags: ["programming"],
				},
				{
					id: "k2",
					topic: "Python",
					content: "Python too",
					source: "inferred",
					createdAt: daysAgo(1),
					updatedAt: daysAgo(1),
					confidence: 0.7,
					tags: ["programming"],
				},
				// Outside period — should still count in totalCount
				{
					id: "k3",
					topic: "Old",
					content: "old stuff",
					source: "taught",
					createdAt: daysAgo(30),
					updatedAt: daysAgo(30),
					confidence: 0.5,
					tags: [],
				},
			]),
			relationships: makeRelationshipManager([
				{
					userId: "u1",
					displayName: "Alice",
					firstSeen: daysAgo(3),
					lastSeen: daysAgo(1),
					interactionCount: 5,
					notes: [],
					preferences: [],
					sentiment: "positive",
				},
				{
					userId: "u2",
					displayName: "Bob",
					firstSeen: daysAgo(14),
					lastSeen: daysAgo(2),
					interactionCount: 3,
					notes: [],
					preferences: [],
					sentiment: "neutral",
				},
			]),
			reflections: makeReflectionManager([
				{
					id: "r1",
					sessionKey: "s1",
					userId: "u1",
					summary: "Learned about TS",
					insights: ["TS is typed"],
					createdAt: daysAgo(2),
				},
			]),
			sessionStore: makeSessionStore([
				{
					sessionId: "s1",
					userId: "u1",
					channelId: "c1",
					claudeSessionId: undefined,
					createdAt: daysAgo(3),
					lastActivityAt: daysAgo(1),
					messageCount: 10,
				},
				{
					sessionId: "s2",
					userId: "u2",
					channelId: "c1",
					claudeSessionId: undefined,
					createdAt: daysAgo(2),
					lastActivityAt: daysAgo(2),
					messageCount: 5,
				},
			]),
			activityTracker: makeActivityTracker([]),
			persona: makePersonaManager({
				learnedTraits: ["curious"],
				preferredTopics: ["programming"],
				communicationStyle: "casual",
			}),
		});

		const stats = await collector.collect(periodStart, periodEnd);

		// Conversations: 2 sessions within period, both count messages
		expect(stats.conversations.totalCount).toBe(15); // 10 + 5
		expect(stats.conversations.uniqueUsers).toBe(2);
		// Alice is new (firstSeen within period), Bob is not (firstSeen 14 days ago)
		expect(stats.conversations.newRelationships).toBe(1);

		// Knowledge: 2 new within period, 3 total
		expect(stats.knowledge.newCount).toBe(2);
		expect(stats.knowledge.totalCount).toBe(3);
		expect(stats.knowledge.mainTopics).toContain("TypeScript");
		expect(stats.knowledge.mainTopics).toContain("Python");

		// Soul
		expect(stats.soul.newTraits).toContain("curious");
		expect(stats.soul.preferredTopics).toContain("programming");

		// Reflections
		expect(stats.reflections.count).toBe(1);
		expect(stats.reflections.highlights).toContain("Learned about TS");
	});

	it("returns zero stats when all stores are empty", async () => {
		const collector = new GrowthCollector({
			knowledge: makeKnowledgeManager([]),
			relationships: makeRelationshipManager([]),
			reflections: makeReflectionManager([]),
			sessionStore: makeSessionStore([]),
			activityTracker: makeActivityTracker([]),
			persona: makePersonaManager(),
		});

		const stats = await collector.collect(daysAgo(7), NOW);

		expect(stats.conversations.totalCount).toBe(0);
		expect(stats.conversations.uniqueUsers).toBe(0);
		expect(stats.conversations.newRelationships).toBe(0);
		expect(stats.knowledge.newCount).toBe(0);
		expect(stats.knowledge.totalCount).toBe(0);
		expect(stats.reflections.count).toBe(0);
	});

	it("computes peak hours from activity records", async () => {
		const hourly = Array(24).fill(0) as number[];
		hourly[14] = 10; // 2pm peak
		hourly[15] = 8;
		hourly[3] = 1;

		const collector = new GrowthCollector({
			knowledge: makeKnowledgeManager([]),
			relationships: makeRelationshipManager([]),
			reflections: makeReflectionManager([]),
			sessionStore: makeSessionStore([]),
			activityTracker: makeActivityTracker([
				{
					userId: "u1",
					hourlyDistribution: hourly,
					sessionStartAt: null,
					lastActivityAt: daysAgo(1),
					lastAlertAt: 0,
					alertsToday: 0,
					alertsResetDate: "",
				},
			]),
			persona: makePersonaManager(),
		});

		const stats = await collector.collect(daysAgo(7), NOW);

		// Peak hours should include 14 (highest)
		expect(stats.activity.peakHours).toContain(14);
	});
});

describe("GrowthCollector.computeDelta", () => {
	it("calculates delta against previous report", () => {
		const previous: ReportHistory = {
			id: "prev",
			generatedAt: daysAgo(7),
			periodStart: daysAgo(14),
			periodEnd: daysAgo(7),
			conversationCount: 20,
			uniqueUsers: 3,
			knowledgeCount: 5,
			relationshipCount: 2,
			reportText: "",
		};

		const delta = GrowthCollector.computeDelta(
			{
				period: { startAt: daysAgo(7), endAt: NOW },
				conversations: {
					totalCount: 30,
					uniqueUsers: 5,
					newRelationships: 2,
				},
				knowledge: {
					newCount: 4,
					totalCount: 9,
					mainTopics: [],
				},
				soul: {
					newTraits: [],
					preferredTopics: [],
					communicationStyle: "",
				},
				activity: { peakHours: [], totalSessions: 0 },
				reflections: { count: 0, highlights: [] },
			},
			previous,
		);

		expect(delta).not.toBeNull();
		expect(delta?.conversationsDelta).toBe(10); // 30 - 20
		expect(delta?.uniqueUsersDelta).toBe(2); // 5 - 3
		expect(delta?.knowledgeDelta).toBe(4); // 9 - 5
		expect(delta?.newRelationshipsDelta).toBe(0); // 2 - 2
	});

	it("returns null when no previous report exists", () => {
		const delta = GrowthCollector.computeDelta(
			{
				period: { startAt: daysAgo(7), endAt: NOW },
				conversations: {
					totalCount: 10,
					uniqueUsers: 2,
					newRelationships: 2,
				},
				knowledge: {
					newCount: 3,
					totalCount: 3,
					mainTopics: [],
				},
				soul: {
					newTraits: [],
					preferredTopics: [],
					communicationStyle: "",
				},
				activity: { peakHours: [], totalSessions: 0 },
				reflections: { count: 0, highlights: [] },
			},
			null,
		);

		expect(delta).toBeNull();
	});
});
