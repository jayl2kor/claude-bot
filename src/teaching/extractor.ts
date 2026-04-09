/**
 * Knowledge extractor — converts detected teaching into structured knowledge.
 *
 * Two-stage pipeline (Issue #41):
 * - If a StagingQueue is provided, items are written to the staging queue for
 *   batch processing by BatchIntegrator (recommended path).
 * - Without a staging queue (legacy), items are stored directly in the
 *   knowledge store (original behaviour, kept for backward compatibility).
 *
 * For preference intents, routes to relationship manager instead of knowledge.
 */

import { randomUUID } from "node:crypto";
import type { FeedPublisher } from "../knowledge-feed/publisher.js";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { RelationshipManager } from "../memory/relationships.js";
import { logger } from "../utils/logger.js";
import type { TeachingIntent } from "./detector.js";
import type { StagingQueue } from "./staging-queue.js";

export type ExtractionResult = {
	stored: number;
	skipped: number;
	/** Number of items enqueued to the staging queue (two-stage pipeline). */
	staged: number;
	entries: KnowledgeEntry[];
};

export class KnowledgeExtractor {
	constructor(
		private readonly knowledge: KnowledgeManager,
		private readonly relationships: RelationshipManager,
		private readonly feedPublisher?: FeedPublisher,
		/** Optional staging queue for the two-stage pipeline (Issue #41). */
		private readonly stagingQueue?: StagingQueue,
	) {}

	/**
	 * Process detected teaching intents.
	 *
	 * Two-stage mode (stagingQueue provided):
	 *   - Preferences go to relationship manager immediately.
	 *   - All other intents are enqueued in the staging queue.
	 *   - Returns staged count; knowledge store is NOT written yet.
	 *
	 * Legacy mode (no stagingQueue):
	 *   - Original behaviour: intents written directly to knowledge store.
	 */
	async extract(
		intents: TeachingIntent[],
		userId: string,
		sessionKey?: string,
	): Promise<ExtractionResult> {
		if (this.stagingQueue) {
			return this.extractToStaging(intents, userId, sessionKey ?? "");
		}
		return this.extractDirect(intents, userId);
	}

	// -------------------------------------------------------------------------
	// Two-stage path: enqueue to staging queue
	// -------------------------------------------------------------------------

	private async extractToStaging(
		intents: TeachingIntent[],
		userId: string,
		sessionKey: string,
	): Promise<ExtractionResult> {
		let staged = 0;
		let skipped = 0;
		const entries: KnowledgeEntry[] = [];

		for (const intent of intents) {
			if (intent.confidence < 0.5) {
				skipped++;
				continue;
			}

			if (intent.type === "preference") {
				// Preferences still go directly to relationship manager
				await this.relationships.addPreference(userId, intent.payload);
				logger.info("Preference stored (staging path)", {
					userId,
					payload: intent.payload,
				});
				staged++;
				continue;
			}

			// Enqueue to staging queue — no heavy integration here
			await this.stagingQueue!.enqueue({
				id: randomUUID(),
				sessionKey,
				userId,
				type: intent.type,
				payload: intent.payload,
				confidence: intent.confidence,
				extractedAt: Date.now(),
				retryCount: 0,
				status: "pending",
			});

			logger.info("Knowledge enqueued to staging queue", {
				sessionKey,
				type: intent.type,
				payload: intent.payload.slice(0, 80),
			});

			staged++;
		}

		return { stored: 0, skipped, staged, entries };
	}

	// -------------------------------------------------------------------------
	// Legacy path: write directly to knowledge store
	// -------------------------------------------------------------------------

	private async extractDirect(
		intents: TeachingIntent[],
		userId: string,
	): Promise<ExtractionResult> {
		let stored = 0;
		let skipped = 0;
		const entries: KnowledgeEntry[] = [];

		for (const intent of intents) {
			if (intent.confidence < 0.5) {
				skipped++;
				continue;
			}

			if (intent.type === "preference") {
				// Route preferences to relationship manager
				await this.relationships.addPreference(userId, intent.payload);
				logger.info("Preference stored", { userId, payload: intent.payload });
				stored++;
				continue;
			}

			// Build knowledge entry
			const topic = extractTopic(intent.payload);
			const existing = await this.knowledge.search(topic, 1);
			const duplicate = existing.find(
				(e) => e.topic === topic && similarity(e.content, intent.payload) > 0.8,
			);

			if (duplicate) {
				if (intent.type === "correction") {
					// Correction overrides existing knowledge — reset strength
					const updated: KnowledgeEntry = {
						...duplicate,
						content: intent.payload,
						source: "corrected",
						confidence: 0.95,
						updatedAt: Date.now(),
						strength: 1.0,
						lastReferencedAt: Date.now(),
					};
					await this.knowledge.upsert(updated);
					entries.push(updated);
					logger.info("Knowledge corrected", { topic, id: duplicate.id });
					stored++;
				} else {
					// Duplicate explicit teaching — skip
					skipped++;
				}
				continue;
			}

			// New knowledge entry
			const now = Date.now();
			const entry: KnowledgeEntry = {
				id: randomUUID(),
				topic,
				content: intent.payload,
				source: intent.type === "correction" ? "corrected" : "taught",
				taughtBy: userId,
				createdAt: now,
				updatedAt: now,
				confidence: intent.type === "correction" ? 0.95 : 0.85,
				tags: extractTags(intent.payload),
				strength: 1.0,
				lastReferencedAt: now,
				referenceCount: 0,
				tier: "scratchpad",
				tierCreatedAt: now,
				promotionScore: 0,
			};

			await this.knowledge.upsert(entry);
			entries.push(entry);
			logger.info("Knowledge stored", {
				topic,
				id: entry.id,
				source: entry.source,
			});

			// Publish to shared feed for cross-pet propagation
			if (this.feedPublisher) {
				await this.feedPublisher.publish(entry).catch((err) => {
					logger.warn("Failed to publish knowledge to feed", {
						id: entry.id,
						error: String(err),
					});
				});
			}

			stored++;
		}

		return { stored, skipped, staged: 0, entries };
	}
}

/** Extract a short topic from the payload text. */
function extractTopic(text: string): string {
	// Take first clause or first N chars as topic
	const firstClause = text.split(/[,.;:!?]/)[0] ?? text;
	return firstClause.slice(0, 50).trim();
}

/** Extract hashtag-like tags from text. */
function extractTags(text: string): string[] {
	const tags: string[] = [];
	// Explicit hashtags
	const hashMatches = text.matchAll(/#(\w+)/g);
	for (const m of hashMatches) {
		tags.push(m[1]!);
	}
	return tags;
}

/** Simple word-overlap similarity (Jaccard). */
function similarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/));
	const wordsB = new Set(b.toLowerCase().split(/\s+/));
	const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
	const union = new Set([...wordsA, ...wordsB]).size;
	return union === 0 ? 0 : intersection / union;
}
