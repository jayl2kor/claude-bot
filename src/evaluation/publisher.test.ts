/**
 * Tests for EvaluationPublisher — covers probability gate and maxPendingCount limit.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvaluationPublisher } from "./publisher.js";
import { EvaluationStore } from "./store.js";
import type { ChatHistoryManager } from "../memory/history.js";

function makeTempDir(): string {
	return join(tmpdir(), `eval-pub-test-${randomUUID()}`);
}

/** Minimal ChatHistoryManager mock */
function makeHistoryMock(messages: Array<{ isBot: boolean; content: string }> = []): ChatHistoryManager {
	return {
		getRecent: vi.fn(async () =>
			messages.map((m, i) => ({
				messageId: String(i),
				userId: "u1",
				userName: "User",
				channelId: "ch-1",
				content: m.content,
				timestamp: Date.now(),
				isBot: m.isBot,
			})),
		),
		append: vi.fn(async () => {}),
		search: vi.fn(async () => []),
		prune: vi.fn(async () => 0),
		listChannels: vi.fn(async () => []),
	} as unknown as ChatHistoryManager;
}

describe("EvaluationPublisher", () => {
	let sharedDir: string;

	beforeEach(async () => {
		sharedDir = makeTempDir();
		await mkdir(sharedDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// Probability gate
	// -------------------------------------------------------------------------

	describe("probability gate", () => {
		it("publishes when Math.random() is below probability threshold", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.1); // 0.1 < 0.3 → publish

			const history = makeHistoryMock([
				{ isBot: false, content: "안녕하세요" },
				{ isBot: true, content: "안녕하세요!" },
			]);

			const publisher = new EvaluationPublisher("pet-a", sharedDir, 0.3, 5);
			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(1);
		});

		it("skips publishing when Math.random() is at or above probability threshold", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5); // 0.5 >= 0.3 → skip

			const history = makeHistoryMock([
				{ isBot: false, content: "테스트" },
				{ isBot: true, content: "응답" },
			]);

			const publisher = new EvaluationPublisher("pet-a", sharedDir, 0.3, 5);
			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});

		it("publishes when probability is 1.0 (always)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.99);

			const history = makeHistoryMock([{ isBot: false, content: "test" }]);
			const publisher = new EvaluationPublisher("pet-a", sharedDir, 1.0, 5);
			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(1);
		});

		it("never publishes when probability is 0.0", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.0); // 0.0 >= 0.0 → skip (not strictly less)

			const history = makeHistoryMock([{ isBot: false, content: "test" }]);
			const publisher = new EvaluationPublisher("pet-a", sharedDir, 0.0, 5);
			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// maxPendingCount limit
	// -------------------------------------------------------------------------

	describe("maxPendingCount", () => {
		it("skips publishing when pending count is at or above maxPendingCount", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.0); // always would publish

			const publisher = new EvaluationPublisher("pet-a", sharedDir, 1.0, 2);

			const history = makeHistoryMock([
				{ isBot: false, content: "msg1" },
				{ isBot: true, content: "res1" },
			]);

			// Pre-fill 2 pending requests directly via the store
			const store = new EvaluationStore(sharedDir);
			const now = Date.now();
			await store.create({
				id: randomUUID(),
				petId: "pet-a",
				channelId: "ch-1",
				userId: "u1",
				promptSummary: "q1",
				responseSummary: "a1",
				timestamp: now,
				status: "pending",
				feedback: null,
				expiresAt: now + 24 * 60 * 60 * 1000,
			});
			await store.create({
				id: randomUUID(),
				petId: "pet-a",
				channelId: "ch-1",
				userId: "u1",
				promptSummary: "q2",
				responseSummary: "a2",
				timestamp: now,
				status: "pending",
				feedback: null,
				expiresAt: now + 24 * 60 * 60 * 1000,
			});

			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			// Should still only be 2 (no new one added)
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(2);
		});

		it("publishes when pending count is below maxPendingCount", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.0); // always publish

			const publisher = new EvaluationPublisher("pet-a", sharedDir, 1.0, 5);

			const history = makeHistoryMock([
				{ isBot: false, content: "hello" },
				{ isBot: true, content: "hi" },
			]);

			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------

	describe("edge cases", () => {
		it("skips publishing when history is empty", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.0); // always publish

			const history = makeHistoryMock([]); // empty
			const publisher = new EvaluationPublisher("pet-a", sharedDir, 1.0, 5);
			await publisher.maybePublish("u1:ch-1", "u1", "ch-1", history);

			const store = new EvaluationStore(sharedDir);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});

		it("does not throw when history.getRecent fails", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.0);

			const history = {
				getRecent: vi.fn(async () => {
					throw new Error("history error");
				}),
			} as unknown as ChatHistoryManager;

			const publisher = new EvaluationPublisher("pet-a", sharedDir, 1.0, 5);
			await expect(
				publisher.maybePublish("u1:ch-1", "u1", "ch-1", history),
			).resolves.not.toThrow();
		});
	});
});
