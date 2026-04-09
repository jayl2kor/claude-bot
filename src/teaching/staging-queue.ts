/**
 * Staging queue for the two-stage learning pipeline (Issue #41).
 *
 * Stage 1 (real-time): Session-end extraction stores items here as lightweight JSON.
 * Stage 2 (batch):     Cron job reads from here, applies write gate, promotes to
 *                      long-term knowledge store.
 *
 * This decouples expensive integration logic from the response path.
 */

import { z } from "zod";
import { FileMemoryStore } from "../memory/store.js";

export const StagedItemSchema = z.object({
	/** Unique item ID. */
	id: z.string(),
	/** Source session key. */
	sessionKey: z.string(),
	/** User who provided the teaching. */
	userId: z.string(),
	/** Teaching intent type. */
	type: z.enum(["explicit", "correction", "preference"]),
	/** Raw extracted payload. */
	payload: z.string(),
	/** Confidence from the detector (0-1). */
	confidence: z.number().min(0).max(1),
	/** Timestamp when this item was extracted. */
	extractedAt: z.number().default(() => Date.now()),
	/** Number of times this item has been evaluated (held → pending cycles). */
	retryCount: z.number().int().min(0).default(0),
	/**
	 * Lifecycle status:
	 * - pending:  waiting to be evaluated by the write gate
	 * - approved: gate approved, will be promoted to knowledge store
	 * - held:     gate held for re-evaluation in next batch
	 * - rejected: gate rejected, will not be stored
	 */
	status: z.enum(["pending", "approved", "held", "rejected"]).default("pending"),
	/** Optional reason from the gate for hold/reject decisions. */
	gateReason: z.string().optional(),
});

export type StagedItem = z.output<typeof StagedItemSchema>;

export class StagingQueue {
	private readonly store: FileMemoryStore<typeof StagedItemSchema>;

	constructor(queueDir: string) {
		this.store = new FileMemoryStore(queueDir, StagedItemSchema);
	}

	/**
	 * Add a new item to the staging queue.
	 * Sets extractedAt to now if zero/falsy.
	 */
	async enqueue(item: StagedItem): Promise<StagedItem> {
		const stored: StagedItem = {
			...item,
			extractedAt: item.extractedAt || Date.now(),
		};
		await this.store.write(item.id, stored);
		return stored;
	}

	/** Retrieve a single item by ID. Returns null if not found. */
	async get(id: string): Promise<StagedItem | null> {
		return this.store.read(id);
	}

	/** List all items with status = 'pending'. */
	async listPending(): Promise<StagedItem[]> {
		const all = await this.store.readAll();
		return all.map((e) => e.value).filter((item) => item.status === "pending");
	}

	/** List all items with status = 'held' (awaiting re-evaluation). */
	async listHeld(): Promise<StagedItem[]> {
		const all = await this.store.readAll();
		return all.map((e) => e.value).filter((item) => item.status === "held");
	}

	/**
	 * Update the status of an item.
	 * When transitioning from held → pending, increments retryCount.
	 */
	async updateStatus(
		id: string,
		status: StagedItem["status"],
		reason?: string,
	): Promise<void> {
		const item = await this.store.read(id);
		if (!item) return;

		const wasHeld = item.status === "held";
		const transitioningToPending = status === "pending";

		const updated: StagedItem = {
			...item,
			status,
			gateReason: reason ?? item.gateReason,
			retryCount:
				wasHeld && transitioningToPending
					? item.retryCount + 1
					: item.retryCount,
		};

		await this.store.write(id, updated);
	}

	/** Remove an item from the queue entirely. */
	async remove(id: string): Promise<void> {
		await this.store.delete(id);
	}

	/**
	 * Expire and remove items older than the given TTL (in ms).
	 * Held items are preserved — they are awaiting re-evaluation.
	 * @returns Number of items removed.
	 */
	async expireOld(ttlMs: number): Promise<number> {
		const all = await this.store.readAll();
		const cutoff = Date.now() - ttlMs;
		let removed = 0;

		for (const { value: item } of all) {
			// Preserve held items for re-evaluation
			if (item.status === "held") continue;

			if (item.extractedAt < cutoff) {
				await this.store.delete(item.id);
				removed++;
			}
		}

		return removed;
	}

	/** Returns the total number of items in the queue (all statuses). */
	async size(): Promise<number> {
		const all = await this.store.readAll();
		return all.length;
	}
}
