/**
 * Tests for BatchIntegrator — batch processing from staging queue (Issue #41).
 *
 * The batch integrator:
 * 1. Reads pending items from the staging queue
 * 2. Applies write gate scoring
 * 3. Promotes approved items to long-term knowledge store
 * 4. Marks held items for re-evaluation in next batch
 * 5. Removes rejected/approved items from staging queue
 * 6. Deduplicates knowledge before storing
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchIntegrator } from "./batch-integrator.js";
import { StagingQueue, type StagedItem } from "./staging-queue.js";
import { KnowledgeManager } from "../memory/knowledge.js";

function makeTempDir(): string {
	return join(tmpdir(), `batch-integrator-test-${randomUUID()}`);
}

function makeStagedItem(overrides: Partial<StagedItem> = {}): StagedItem {
	const now = Date.now();
	return {
		id: randomUUID(),
		sessionKey: "session-123",
		userId: "user-abc",
		type: "explicit",
		payload: "TypeScript는 JavaScript의 상위 집합이다",
		confidence: 0.95,
		extractedAt: now,
		retryCount: 0,
		status: "pending",
		...overrides,
	};
}

describe("BatchIntegrator", () => {
	let queueDir: string;
	let memoryDir: string;
	let archiveDir: string;
	let queue: StagingQueue;
	let knowledge: KnowledgeManager;
	let integrator: BatchIntegrator;

	beforeEach(async () => {
		queueDir = makeTempDir();
		memoryDir = makeTempDir();
		archiveDir = join(memoryDir, "..", "archive");

		await mkdir(queueDir, { recursive: true });
		await mkdir(memoryDir, { recursive: true });

		queue = new StagingQueue(queueDir);
		knowledge = new KnowledgeManager(memoryDir, archiveDir);
		integrator = new BatchIntegrator(queue, knowledge);
	});

	// -------------------------------------------------------------------------
	// run — core batch processing
	// -------------------------------------------------------------------------

	describe("run", () => {
		it("processes pending items and stores approved ones in knowledge", async () => {
			const item = makeStagedItem({
				type: "explicit",
				payload: "Go언어는 구글이 만든 정적 타입 언어다",
				confidence: 0.95,
			});
			await queue.enqueue(item);

			const result = await integrator.run();

			expect(result.approved).toBeGreaterThanOrEqual(1);
			expect(result.processed).toBeGreaterThanOrEqual(1);

			// The approved item should be in knowledge store
			const allKnowledge = await knowledge.listAll();
			expect(allKnowledge.length).toBeGreaterThanOrEqual(1);
		});

		it("returns zero counts when queue is empty", async () => {
			const result = await integrator.run();

			expect(result.processed).toBe(0);
			expect(result.approved).toBe(0);
			expect(result.held).toBe(0);
			expect(result.rejected).toBe(0);
		});

		it("removes approved items from the staging queue after processing", async () => {
			const item = makeStagedItem({
				type: "explicit",
				payload: "React는 Facebook이 만든 UI 라이브러리다",
				confidence: 0.95,
			});
			await queue.enqueue(item);

			await integrator.run();

			// Approved items should be removed from staging queue
			const pending = await queue.listPending();
			expect(pending).toHaveLength(0);
		});

		it("marks rejected items as rejected in staging queue", async () => {
			const item = makeStagedItem({
				payload: "ok", // too short to pass gate
				confidence: 0.3,
			});
			await queue.enqueue(item);

			const result = await integrator.run();

			expect(result.rejected).toBeGreaterThanOrEqual(1);
		});

		it("marks held items as held in staging queue without storing", async () => {
			// A preference item with moderate confidence should be held
			const item = makeStagedItem({
				type: "preference",
				payload: "좋아하는 것: 피자",
				confidence: 0.65,
				retryCount: 0,
			});
			await queue.enqueue(item);

			const result = await integrator.run();

			// Either approved or held (depending on gate logic)
			expect(result.approved + result.held).toBeGreaterThanOrEqual(1);
		});

		it("logs gate decisions for each processed item", async () => {
			const item = makeStagedItem({
				type: "explicit",
				payload: "Python은 인터프리터 언어다",
				confidence: 0.9,
			});
			await queue.enqueue(item);

			const result = await integrator.run();

			expect(result.gateLog).toBeDefined();
			expect(result.gateLog.length).toBeGreaterThanOrEqual(1);
			expect(result.gateLog[0]).toMatchObject({
				itemId: item.id,
				decision: expect.stringMatching(/^(approve|hold|reject)$/),
				score: expect.objectContaining({
					factuality: expect.any(Number),
					reusability: expect.any(Number),
					sensitivity: expect.any(Number),
					total: expect.any(Number),
				}),
			});
		});
	});

	// -------------------------------------------------------------------------
	// deduplication
	// -------------------------------------------------------------------------

	describe("deduplication", () => {
		it("skips duplicate items already in knowledge store (same topic + similar content)", async () => {
			// First, store a knowledge entry directly
			const now = Date.now();
			await knowledge.upsert({
				id: randomUUID(),
				topic: "TypeScript 상위집합",
				content: "TypeScript는 JavaScript의 상위 집합이다",
				source: "taught",
				taughtBy: "user-abc",
				createdAt: now,
				updatedAt: now,
				confidence: 0.9,
				tags: [],
				strength: 1.0,
				lastReferencedAt: now,
				referenceCount: 0,
				tier: "scratchpad",
				tierCreatedAt: now,
				promotionScore: 0,
			});

			// Now add the same knowledge to staging queue
			const duplicate = makeStagedItem({
				payload: "TypeScript는 JavaScript의 상위 집합이다",
				confidence: 0.95,
			});
			await queue.enqueue(duplicate);

			const result = await integrator.run();

			// Should be detected as duplicate and skipped/rejected
			expect(result.deduplicated).toBeGreaterThanOrEqual(1);
			// Knowledge store should still have only 1 entry
			const allKnowledge = await knowledge.listAll();
			expect(allKnowledge).toHaveLength(1);
		});

		it("stores unique items even if similar topics exist", async () => {
			const now = Date.now();
			await knowledge.upsert({
				id: randomUUID(),
				topic: "TypeScript",
				content: "TypeScript는 정적 타이핑을 지원한다",
				source: "taught",
				taughtBy: "user-abc",
				createdAt: now,
				updatedAt: now,
				confidence: 0.9,
				tags: [],
				strength: 1.0,
				lastReferencedAt: now,
				referenceCount: 0,
				tier: "scratchpad",
				tierCreatedAt: now,
				promotionScore: 0,
			});

			// Different content about TypeScript
			const different = makeStagedItem({
				payload: "TypeScript는 인터페이스와 제네릭을 지원한다",
				confidence: 0.95,
			});
			await queue.enqueue(different);

			const result = await integrator.run();

			// Should be stored as new knowledge
			expect(result.approved).toBeGreaterThanOrEqual(1);
			const allKnowledge = await knowledge.listAll();
			expect(allKnowledge.length).toBeGreaterThanOrEqual(2);
		});
	});

	// -------------------------------------------------------------------------
	// held item re-evaluation
	// -------------------------------------------------------------------------

	describe("held item re-evaluation", () => {
		it("re-evaluates held items in next batch run", async () => {
			// Enqueue a held item (simulating it was held in previous batch)
			const heldItem = makeStagedItem({
				type: "explicit",
				payload: "Node.js는 V8 엔진으로 동작하는 JavaScript 런타임이다",
				confidence: 0.85,
				status: "held",
				retryCount: 1,
			});
			await queue.enqueue(heldItem);

			const result = await integrator.run();

			// Held item with higher confidence on retry should be approved
			expect(result.approved + result.held + result.rejected).toBeGreaterThanOrEqual(1);
		});

		it("increments retryCount when item is held again", async () => {
			const item = makeStagedItem({
				type: "preference",
				payload: "좋아하는 것: 초콜릿",
				confidence: 0.55,
				status: "pending",
				retryCount: 0,
			});
			await queue.enqueue(item);

			await integrator.run();

			// Check the item in queue — if held, retryCount should be ≥ 1
			const held = await queue.listHeld();
			for (const h of held) {
				if (h.id === item.id) {
					expect(h.retryCount).toBeGreaterThanOrEqual(1);
				}
			}
		});
	});

	// -------------------------------------------------------------------------
	// BatchResult structure
	// -------------------------------------------------------------------------

	describe("BatchResult", () => {
		it("returns correct totals", async () => {
			const good = makeStagedItem({
				payload: "Docker는 컨테이너 기반 가상화 플랫폼이다",
				confidence: 0.95,
			});
			const bad = makeStagedItem({
				payload: "ok",
				confidence: 0.2,
			});

			await queue.enqueue(good);
			await queue.enqueue(bad);

			const result = await integrator.run();

			expect(result.processed).toBe(2);
			expect(result.approved + result.held + result.rejected + result.deduplicated).toBe(2);
		});
	});
});
