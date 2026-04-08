/**
 * Feed publisher — publishes knowledge entries to the shared feed.
 * Skips entries with source "propagated" to prevent infinite loops.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import type { FeedStore } from "./feed-store.js";
import type { FeedEntry } from "./types.js";

export type PublishableEntry = {
	readonly id: string;
	readonly topic: string;
	readonly content: string;
	readonly confidence: number;
	readonly source: 'taught' | 'inferred' | 'corrected' | 'propagated';
	readonly tags: readonly string[];
};

export class FeedPublisher {
	constructor(
		private readonly feedStore: FeedStore,
		private readonly petId: string,
	) {}

	/**
	 * Publish a knowledge entry to the shared feed.
	 * Returns the feed entry if published, null if skipped.
	 */
	async publish(entry: PublishableEntry): Promise<FeedEntry | null> {
		// Prevent circular propagation
		if (entry.source === "propagated") {
			logger.debug("Skipping propagated entry to prevent circular feed", {
				id: entry.id,
				topic: entry.topic,
			});
			return null;
		}

		const feedEntry: FeedEntry = {
			id: randomUUID(),
			sourcePetId: this.petId,
			originalKnowledgeId: entry.id,
			topic: entry.topic,
			content: entry.content,
			confidence: entry.confidence,
			source: entry.source,
			tags: [...entry.tags],
			publishedAt: Date.now(),
		};

		await this.feedStore.write(feedEntry);
		logger.info("Knowledge published to feed", {
			feedId: feedEntry.id,
			topic: feedEntry.topic,
			sourcePetId: this.petId,
		});

		return feedEntry;
	}
}
