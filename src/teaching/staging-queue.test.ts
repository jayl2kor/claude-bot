/**
 * Tests for StagingQueue — two-stage learning pipeline (Issue #41).
 *
 * The staging queue holds extracted knowledge before batch integration.
 * Items are stored as JSON and can be listed, consumed, and expired.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { StagingQueue, type StagedItem } from "./staging-queue.js";

function makeTempDir(): string {
	return join(tmpdir(), `staging-queue-test-${randomUUID()}`);
}

function makeStagedItem(overrides: Partial<StagedItem> = {}): StagedItem {
	const now = Date.now();
	return {
		id: randomUUID(),
		sessionKey: "session-123",
		userId: "user-abc",
		type: "explicit",
		payload: "좋아하는 음식은 피자야",
		confidence: 0.95,
		extractedAt: now,
		retryCount: 0,
		status: "pending",
		...overrides,
	};
}

describe("StagingQueue", () => {
	let queueDir: string;
	let queue: StagingQueue;

	beforeEach(async () => {
		queueDir = makeTempDir();
		await mkdir(queueDir, { recursive: true });
		queue = new StagingQueue(queueDir);
	});

	// -------------------------------------------------------------------------
	// enqueue
	// -------------------------------------------------------------------------

	describe("enqueue", () => {
		it("stores a staged item and returns it", async () => {
			const item = makeStagedItem();
			const stored = await queue.enqueue(item);

			expect(stored.id).toBe(item.id);
			expect(stored.status).toBe("pending");
		});

		it("persists item so it can be retrieved", async () => {
			const item = makeStagedItem();
			await queue.enqueue(item);

			const retrieved = await queue.get(item.id);
			expect(retrieved).not.toBeNull();
			expect(retrieved?.payload).toBe(item.payload);
		});

		it("assigns extractedAt if not provided", async () => {
			const item = makeStagedItem({ extractedAt: 0 });
			const before = Date.now();
			await queue.enqueue(item);
			const after = Date.now();

			const retrieved = await queue.get(item.id);
			expect(retrieved?.extractedAt).toBeGreaterThanOrEqual(before);
			expect(retrieved?.extractedAt).toBeLessThanOrEqual(after);
		});
	});

	// -------------------------------------------------------------------------
	// listPending
	// -------------------------------------------------------------------------

	describe("listPending", () => {
		it("returns only pending items", async () => {
			const pending1 = makeStagedItem({ status: "pending" });
			const pending2 = makeStagedItem({ status: "pending" });
			const approved = makeStagedItem({ status: "approved" });
			const rejected = makeStagedItem({ status: "rejected" });
			const held = makeStagedItem({ status: "held" });

			await queue.enqueue(pending1);
			await queue.enqueue(pending2);
			await queue.enqueue(approved);
			await queue.enqueue(rejected);
			await queue.enqueue(held);

			const result = await queue.listPending();
			expect(result).toHaveLength(2);
			const ids = result.map((r) => r.id);
			expect(ids).toContain(pending1.id);
			expect(ids).toContain(pending2.id);
		});

		it("returns empty array when no pending items", async () => {
			const result = await queue.listPending();
			expect(result).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// listHeld
	// -------------------------------------------------------------------------

	describe("listHeld", () => {
		it("returns only held items", async () => {
			const held = makeStagedItem({ status: "held" });
			const pending = makeStagedItem({ status: "pending" });

			await queue.enqueue(held);
			await queue.enqueue(pending);

			const result = await queue.listHeld();
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe(held.id);
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("updates item status to approved", async () => {
			const item = makeStagedItem();
			await queue.enqueue(item);

			await queue.updateStatus(item.id, "approved");

			const retrieved = await queue.get(item.id);
			expect(retrieved?.status).toBe("approved");
		});

		it("updates item status to rejected", async () => {
			const item = makeStagedItem();
			await queue.enqueue(item);

			await queue.updateStatus(item.id, "rejected");

			const retrieved = await queue.get(item.id);
			expect(retrieved?.status).toBe("rejected");
		});

		it("updates item status to held with reason", async () => {
			const item = makeStagedItem();
			await queue.enqueue(item);

			await queue.updateStatus(item.id, "held", "Low reusability score");

			const retrieved = await queue.get(item.id);
			expect(retrieved?.status).toBe("held");
			expect(retrieved?.gateReason).toBe("Low reusability score");
		});

		it("increments retryCount when transitioning from held to pending", async () => {
			const item = makeStagedItem({ status: "held", retryCount: 1 });
			await queue.enqueue(item);

			await queue.updateStatus(item.id, "pending");

			const retrieved = await queue.get(item.id);
			expect(retrieved?.retryCount).toBe(2);
		});

		it("is no-op for nonexistent id", async () => {
			await expect(
				queue.updateStatus("nonexistent-id", "approved"),
			).resolves.not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// remove
	// -------------------------------------------------------------------------

	describe("remove", () => {
		it("removes an item from the queue", async () => {
			const item = makeStagedItem();
			await queue.enqueue(item);

			await queue.remove(item.id);

			const retrieved = await queue.get(item.id);
			expect(retrieved).toBeNull();
		});

		it("does not throw when removing nonexistent item", async () => {
			await expect(queue.remove("nonexistent-id")).resolves.not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// expireOld
	// -------------------------------------------------------------------------

	describe("expireOld", () => {
		it("removes items older than TTL", async () => {
			const old = makeStagedItem({
				extractedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
				status: "pending",
			});
			const fresh = makeStagedItem({
				extractedAt: Date.now() - 1_000, // 1 second ago
				status: "pending",
			});

			await queue.enqueue(old);
			await queue.enqueue(fresh);

			const removed = await queue.expireOld(24 * 60 * 60 * 1000); // 1 day TTL

			expect(removed).toBe(1);
			expect(await queue.get(old.id)).toBeNull();
			expect(await queue.get(fresh.id)).not.toBeNull();
		});

		it("does not expire held items waiting for re-evaluation", async () => {
			const heldOld = makeStagedItem({
				extractedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
				status: "held",
			});
			await queue.enqueue(heldOld);

			const removed = await queue.expireOld(24 * 60 * 60 * 1000);

			// held items are preserved for re-evaluation in next batch
			expect(removed).toBe(0);
			expect(await queue.get(heldOld.id)).not.toBeNull();
		});

		it("returns 0 when no items to expire", async () => {
			const removed = await queue.expireOld(24 * 60 * 60 * 1000);
			expect(removed).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// size
	// -------------------------------------------------------------------------

	describe("size", () => {
		it("returns total number of items in queue", async () => {
			expect(await queue.size()).toBe(0);

			await queue.enqueue(makeStagedItem());
			await queue.enqueue(makeStagedItem());

			expect(await queue.size()).toBe(2);
		});
	});
});
