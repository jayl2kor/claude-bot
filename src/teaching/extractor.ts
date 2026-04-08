/**
 * Knowledge extractor — converts detected teaching into structured knowledge.
 *
 * For explicit and correction intents, extracts topic + content directly.
 * For preference intents, routes to relationship manager instead.
 */

import { randomUUID } from "node:crypto";
import type { FeedPublisher } from "../knowledge-feed/publisher.js";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { RelationshipManager } from "../memory/relationships.js";
import { logger } from "../utils/logger.js";
import type { TeachingIntent } from "./detector.js";

export type ExtractionResult = {
	stored: number;
	skipped: number;
	entries: KnowledgeEntry[];
};

export class KnowledgeExtractor {
	constructor(
		private readonly knowledge: KnowledgeManager,
		private readonly relationships: RelationshipManager,
		private readonly feedPublisher?: FeedPublisher,
	) {}

	/**
	 * Process detected teaching intents and store as knowledge/preferences.
	 */
	async extract(
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
					// Correction overrides existing knowledge
					const updated: KnowledgeEntry = {
						...duplicate,
						content: intent.payload,
						source: "corrected",
						confidence: 0.95,
						updatedAt: Date.now(),
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
			const entry: KnowledgeEntry = {
				id: randomUUID(),
				topic,
				content: intent.payload,
				source: intent.type === "correction" ? "corrected" : "taught",
				taughtBy: userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: intent.type === "correction" ? 0.95 : 0.85,
				tags: extractTags(intent.payload),
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

		return { stored, skipped, entries };
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
