/**
 * Tests for study status checker — covers:
 * - Status question detection (공부 다 했어?, 학습 상태, 공부 현황)
 * - Response formatting with emoji indicators
 */

import { describe, expect, it } from "vitest";
import { detectStatusCheck, formatStatusResponse } from "./status-checker.js";
import type { StudyQueueState } from "./types.js";

describe("detectStatusCheck — positive detection", () => {
	it("detects '공부 다 했어?'", () => {
		expect(detectStatusCheck("공부 다 했어?")).toBe(true);
	});

	it("detects '공부 다 했어'", () => {
		expect(detectStatusCheck("공부 다 했어")).toBe(true);
	});

	it("detects '공부 다했어?'", () => {
		expect(detectStatusCheck("공부 다했어?")).toBe(true);
	});

	it("detects '학습 상태'", () => {
		expect(detectStatusCheck("학습 상태")).toBe(true);
	});

	it("detects '학습 상태 알려줘'", () => {
		expect(detectStatusCheck("학습 상태 알려줘")).toBe(true);
	});

	it("detects '공부 현황'", () => {
		expect(detectStatusCheck("공부 현황")).toBe(true);
	});

	it("detects '공부 현황 어때'", () => {
		expect(detectStatusCheck("공부 현황 어때")).toBe(true);
	});

	it("detects '공부 끝났어?'", () => {
		expect(detectStatusCheck("공부 끝났어?")).toBe(true);
	});

	it("detects '리서치 끝났어?'", () => {
		expect(detectStatusCheck("리서치 끝났어?")).toBe(true);
	});

	it("detects '/study-status'", () => {
		expect(detectStatusCheck("/study-status")).toBe(true);
	});
});

describe("detectStatusCheck — negative cases", () => {
	it("rejects general conversation", () => {
		expect(detectStatusCheck("오늘 뭐 했어?")).toBe(false);
	});

	it("rejects study commands", () => {
		expect(detectStatusCheck("Docker에 대해 공부해")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(detectStatusCheck("")).toBe(false);
	});
});

describe("formatStatusResponse", () => {
	it("shows empty queue message when no requests", () => {
		const state: StudyQueueState = {
			requests: [],
			dailyCount: 0,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("학습 대기열이 비어있습니다");
	});

	it("shows completed items with checkmark", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "1",
					topic: "Docker",
					status: "completed",
					requestedAt: Date.now() - 60000,
					completedAt: Date.now(),
					result: {
						subtopics: [{ topic: "a", content: "b", tags: [] }],
						knowledgeIds: ["k1"],
					},
				},
			],
			dailyCount: 1,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("Docker");
		expect(result).toContain("completed");
	});

	it("shows in_progress items with spinner", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "2",
					topic: "Kubernetes",
					status: "in_progress",
					requestedAt: Date.now() - 30000,
				},
			],
			dailyCount: 1,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("Kubernetes");
		expect(result).toContain("in_progress");
	});

	it("shows queued items with clock", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "3",
					topic: "GraphQL",
					status: "queued",
					requestedAt: Date.now(),
				},
			],
			dailyCount: 0,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("GraphQL");
		expect(result).toContain("queued");
	});

	it("shows failed items with cross", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "4",
					topic: "Blockchain",
					status: "failed",
					requestedAt: Date.now() - 60000,
					error: "Parse error",
				},
			],
			dailyCount: 1,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("Blockchain");
		expect(result).toContain("failed");
	});

	it("shows daily count and limit info", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "1",
					topic: "Docker",
					status: "completed",
					requestedAt: Date.now(),
					completedAt: Date.now(),
					result: { subtopics: [], knowledgeIds: [] },
				},
			],
			dailyCount: 3,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("3");
	});

	it("shows multiple requests in order", () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "1",
					topic: "Docker",
					status: "completed",
					requestedAt: Date.now() - 120000,
					completedAt: Date.now() - 60000,
					result: { subtopics: [], knowledgeIds: [] },
				},
				{
					id: "2",
					topic: "K8s",
					status: "in_progress",
					requestedAt: Date.now() - 30000,
				},
				{
					id: "3",
					topic: "Redis",
					status: "queued",
					requestedAt: Date.now(),
				},
			],
			dailyCount: 3,
			dailyResetAt: Date.now() + 86400000,
		};
		const result = formatStatusResponse(state);
		expect(result).toContain("Docker");
		expect(result).toContain("K8s");
		expect(result).toContain("Redis");
	});
});
