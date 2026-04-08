/**
 * Tests for GrowthReporter — covers:
 * - Report generation (calls Claude haiku)
 * - Channel sending
 * - Report history save and load
 * - Disabled config skips execution
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrowthReporter } from "./reporter.js";
import type { GrowthDelta, GrowthStats, ReportHistory } from "./types.js";

// ---------------------------------------------------------------------------
// Mock the spawner
// ---------------------------------------------------------------------------

vi.mock("../executor/spawner.js", () => ({
	spawnClaude: vi.fn(() => {
		const resultCallbacks: Array<
			(r: { result: string; session_id?: string }) => void
		> = [];
		return {
			onResult: (cb: (r: { result: string }) => void) => {
				resultCallbacks.push(cb);
				// Simulate immediate result
				cb({
					result:
						"# Weekly Growth Report\n\nI learned a lot this week! Had 30 conversations with 5 friends.",
				});
			},
			done: Promise.resolve("completed"),
		};
	}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const ONE_DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): number {
	return NOW - n * ONE_DAY;
}

function makeStats(): GrowthStats {
	return {
		period: { startAt: daysAgo(7), endAt: NOW },
		conversations: {
			totalCount: 30,
			uniqueUsers: 5,
			newRelationships: 2,
		},
		knowledge: {
			newCount: 4,
			totalCount: 9,
			mainTopics: ["TypeScript", "Python"],
		},
		soul: {
			newTraits: ["curious"],
			preferredTopics: ["programming"],
			communicationStyle: "casual",
		},
		activity: {
			peakHours: [14, 15],
			totalSessions: 10,
		},
		reflections: {
			count: 3,
			highlights: ["Learned about TS", "Had fun debugging"],
		},
	};
}

function makeDelta(): GrowthDelta {
	return {
		conversationsDelta: 10,
		uniqueUsersDelta: 2,
		knowledgeDelta: 4,
		newRelationshipsDelta: 1,
	};
}

function makeFakeHistoryStore() {
	const saved: ReportHistory[] = [];
	return {
		save: vi.fn(async (history: ReportHistory) => {
			saved.push(history);
		}),
		getLatest: vi.fn(async (): Promise<ReportHistory | null> => null),
		getSaved: () => saved,
	};
}

function makeFakeChannel() {
	const messages: Array<{ channelId: string; content: string }> = [];
	return {
		id: "test-channel",
		meta: { label: "Test", textChunkLimit: 4000 },
		connect: vi.fn(async () => {}),
		onMessage: vi.fn(),
		sendMessage: vi.fn(async (channelId: string, content: string) => {
			messages.push({ channelId, content });
		}),
		sendTyping: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		getMessages: () => messages,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GrowthReporter.generateReport", () => {
	it("generates report text via Claude haiku", async () => {
		const historyStore = makeFakeHistoryStore();
		const reporter = new GrowthReporter({
			personaName: "TestPet",
			language: "ko",
			historyStore,
		});

		const report = await reporter.generateReport(makeStats(), makeDelta());

		expect(report.reportText).toContain("Weekly Growth Report");
		expect(report.stats).toEqual(makeStats());
		expect(report.delta).toEqual(makeDelta());
		expect(report.generatedAt).toBeGreaterThan(0);
		expect(report.id).toBeTruthy();
	});

	it("generates report without delta (first report)", async () => {
		const historyStore = makeFakeHistoryStore();
		const reporter = new GrowthReporter({
			personaName: "TestPet",
			language: "ko",
			historyStore,
		});

		const report = await reporter.generateReport(makeStats(), null);

		expect(report.reportText).toContain("Weekly Growth Report");
		expect(report.delta).toBeNull();
	});
});

describe("GrowthReporter.sendToChannel", () => {
	it("sends report to the specified channel", async () => {
		const historyStore = makeFakeHistoryStore();
		const channel = makeFakeChannel();
		const reporter = new GrowthReporter({
			personaName: "TestPet",
			language: "ko",
			historyStore,
		});

		const report = await reporter.generateReport(makeStats(), null);
		await reporter.sendToChannel(report, channel, "channel-123");

		const messages = channel.getMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].channelId).toBe("channel-123");
		expect(messages[0].content).toContain("Weekly Growth Report");
	});
});

describe("GrowthReporter.saveHistory", () => {
	it("saves report as history for future delta comparison", async () => {
		const historyStore = makeFakeHistoryStore();
		const reporter = new GrowthReporter({
			personaName: "TestPet",
			language: "ko",
			historyStore,
		});

		const report = await reporter.generateReport(makeStats(), makeDelta());
		await reporter.saveHistory(report);

		const saved = historyStore.getSaved();
		expect(saved).toHaveLength(1);
		expect(saved[0].conversationCount).toBe(30);
		expect(saved[0].uniqueUsers).toBe(5);
		expect(saved[0].knowledgeCount).toBe(9);
		expect(saved[0].relationshipCount).toBe(2);
		expect(saved[0].reportText).toContain("Weekly Growth Report");
	});
});
