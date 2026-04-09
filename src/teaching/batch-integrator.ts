/**
 * Batch integrator — Stage 2 of the two-stage learning pipeline (Issue #41).
 *
 * Runs on a periodic cron schedule to:
 * 1. Pull pending + held items from the staging queue
 * 2. Apply write gate scoring (factuality / reusability / sensitivity)
 * 3. Store approved items in the knowledge store (with deduplication)
 * 4. Re-queue held items (incrementing retryCount)
 * 5. Remove rejected and approved items from the staging queue
 * 6. Log all gate decisions for observability
 *
 * This keeps expensive integration logic out of the real-time response path.
 */

import { randomUUID } from "node:crypto";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import { logger } from "../utils/logger.js";
import type { StagedItem } from "./staging-queue.js";
import { StagingQueue } from "./staging-queue.js";
import { WriteGate } from "./write-gate.js";
import type { GateResult } from "./write-gate.js";

export type GateLogEntry = {
	itemId: string;
	decision: "approve" | "hold" | "reject";
	score: GateResult["score"];
	reason: string;
};

export type BatchResult = {
	/** Total items processed in this batch. */
	processed: number;
	/** Items approved and stored in knowledge. */
	approved: number;
	/** Items held for re-evaluation in next batch. */
	held: number;
	/** Items rejected and removed from queue. */
	rejected: number;
	/** Items skipped as duplicates of existing knowledge. */
	deduplicated: number;
	/** Per-item gate decision log. */
	gateLog: GateLogEntry[];
};

/** Word-overlap similarity (Jaccard index). */
function similarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/));
	const wordsB = new Set(b.toLowerCase().split(/\s+/));
	const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
	const union = new Set([...wordsA, ...wordsB]).size;
	return union === 0 ? 0 : intersection / union;
}

/** Extract a short topic from the payload text (first clause, max 50 chars). */
function extractTopic(text: string): string {
	const firstClause = text.split(/[,.;:!?]/)[0] ?? text;
	return firstClause.slice(0, 50).trim();
}

export class BatchIntegrator {
	private readonly gate: WriteGate;

	constructor(
		private readonly queue: StagingQueue,
		private readonly knowledge: KnowledgeManager,
	) {
		this.gate = new WriteGate();
	}

	/**
	 * Run one batch integration cycle.
	 * Processes both pending and held items.
	 *
	 * @returns Summary of what happened during this batch.
	 */
	async run(): Promise<BatchResult> {
		const result: BatchResult = {
			processed: 0,
			approved: 0,
			held: 0,
			rejected: 0,
			deduplicated: 0,
			gateLog: [],
		};

		// Collect pending + held items for this batch
		const [pendingItems, heldItems] = await Promise.all([
			this.queue.listPending(),
			this.queue.listHeld(),
		]);
		const items = [...pendingItems, ...heldItems];

		if (items.length === 0) {
			logger.debug("Batch integrator: no items to process");
			return result;
		}

		logger.info("Batch integrator: starting batch", {
			pending: pendingItems.length,
			held: heldItems.length,
		});

		for (const item of items) {
			result.processed++;

			const { result: gateResult } = this.gate.evaluateMany([item])[0]!;

			// Log gate decision
			const logEntry: GateLogEntry = {
				itemId: item.id,
				decision: gateResult.decision,
				score: gateResult.score,
				reason: gateResult.reason,
			};
			result.gateLog.push(logEntry);

			logger.info("Batch integrator: gate decision", {
				itemId: item.id,
				decision: gateResult.decision,
				total: gateResult.score.total.toFixed(3),
				reason: gateResult.reason,
			});

			switch (gateResult.decision) {
				case "approve": {
					const isDuplicate = await this.checkDuplicate(item);
					if (isDuplicate) {
						result.deduplicated++;
						await this.queue.remove(item.id);
						logger.debug("Batch integrator: deduped item", {
							itemId: item.id,
							payload: item.payload.slice(0, 60),
						});
					} else {
						await this.storeKnowledge(item);
						await this.queue.remove(item.id);
						result.approved++;
					}
					break;
				}

				case "hold": {
					// Mark as held for re-evaluation in next batch
					await this.queue.updateStatus(
						item.id,
						"held",
						gateResult.reason,
					);
					result.held++;
					logger.debug("Batch integrator: item held for re-evaluation", {
						itemId: item.id,
						retryCount: item.retryCount,
					});
					break;
				}

				case "reject": {
					await this.queue.updateStatus(
						item.id,
						"rejected",
						gateResult.reason,
					);
					result.rejected++;
					logger.debug("Batch integrator: item rejected", {
						itemId: item.id,
						reason: gateResult.reason,
					});
					break;
				}
			}
		}

		logger.info("Batch integrator: batch complete", {
			processed: result.processed,
			approved: result.approved,
			held: result.held,
			rejected: result.rejected,
			deduplicated: result.deduplicated,
		});

		return result;
	}

	/**
	 * Check whether an item is a near-duplicate of existing knowledge.
	 * Uses topic extraction + Jaccard similarity on content.
	 */
	private async checkDuplicate(item: StagedItem): Promise<boolean> {
		const topic = extractTopic(item.payload);
		const existing = await this.knowledge.search(topic, 5);

		return existing.some(
			(e) =>
				e.topic === topic ||
				similarity(e.content, item.payload) > 0.75,
		);
	}

	/**
	 * Convert a staged item to a KnowledgeEntry and upsert it.
	 */
	private async storeKnowledge(item: StagedItem): Promise<void> {
		const now = Date.now();
		const topic = extractTopic(item.payload);

		const entry: KnowledgeEntry = {
			id: randomUUID(),
			topic,
			content: item.payload,
			source: item.type === "correction" ? "corrected" : "taught",
			taughtBy: item.userId,
			createdAt: now,
			updatedAt: now,
			confidence: item.confidence,
			tags: [],
			strength: 1.0,
			lastReferencedAt: now,
			referenceCount: 0,
			tier: "scratchpad",
			tierCreatedAt: now,
			promotionScore: 0,
		};

		await this.knowledge.upsert(entry);

		logger.debug("Batch integrator: knowledge stored", {
			topic,
			source: entry.source,
			confidence: entry.confidence,
		});
	}
}
