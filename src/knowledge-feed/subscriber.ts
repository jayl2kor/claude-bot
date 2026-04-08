/**
 * Feed subscriber — polls the shared feed, imports new entries
 * as local knowledge with reduced confidence.
 *
 * Checkpoint: persists last poll timestamp to file for crash recovery.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { FeedStore } from "./feed-store.js";
import type { FeedEntry } from "./types.js";

export type SubscriberConfig = {
	readonly feedStore: FeedStore;
	readonly knowledge: KnowledgeManager;
	readonly petId: string;
	readonly stateDir: string;
	readonly confidenceMultiplier: number;
};

export type PollResult = {
	readonly imported: number;
	readonly skipped: number;
};

type CheckpointState = {
	readonly lastPollTimestamp: number;
};

export class FeedSubscriber {
	private readonly feedStore: FeedStore;
	private readonly knowledge: KnowledgeManager;
	private readonly petId: string;
	private readonly stateDir: string;
	private readonly confidenceMultiplier: number;
	private lastPollTimestamp: number | null = null;

	constructor(config: SubscriberConfig) {
		this.feedStore = config.feedStore;
		this.knowledge = config.knowledge;
		this.petId = config.petId;
		this.stateDir = config.stateDir;
		this.confidenceMultiplier = config.confidenceMultiplier;
	}

	/**
	 * Poll the feed for new entries and import them.
	 * Entries from the same pet, or with topics already known locally, are skipped.
	 */
	async poll(): Promise<PollResult> {
		const checkpoint = await this.loadCheckpoint();
		const entries = await this.feedStore.listSince(checkpoint);

		let imported = 0;
		let skipped = 0;
		let latestTimestamp = checkpoint;

		for (const entry of entries) {
			// Track latest timestamp for checkpoint
			if (entry.publishedAt > latestTimestamp) {
				latestTimestamp = entry.publishedAt;
			}

			// Skip self-propagation
			if (entry.sourcePetId === this.petId) {
				skipped++;
				continue;
			}

			// Duplicate check: skip if topic already exists in local knowledge
			const existing = await this.knowledge.findByTopic(entry.topic);
			if (existing.length > 0) {
				skipped++;
				logger.debug("Skipping feed entry — topic already known", {
					feedId: entry.id,
					topic: entry.topic,
				});
				continue;
			}

			// Import with reduced confidence
			const localEntry: KnowledgeEntry = {
				id: randomUUID(),
				topic: entry.topic,
				content: entry.content,
				source: "propagated",
				propagatedFrom: entry.sourcePetId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: entry.confidence * this.confidenceMultiplier,
				tags: [...entry.tags],
			};

			await this.knowledge.upsert(localEntry);
			imported++;

			logger.info("Knowledge imported from feed", {
				feedId: entry.id,
				localId: localEntry.id,
				topic: entry.topic,
				sourcePet: entry.sourcePetId,
				confidence: localEntry.confidence,
			});
		}

		// Persist checkpoint
		await this.saveCheckpoint(latestTimestamp);

		return { imported, skipped };
	}

	private async loadCheckpoint(): Promise<number> {
		if (this.lastPollTimestamp !== null) {
			return this.lastPollTimestamp;
		}

		try {
			const raw = await readFile(this.checkpointPath(), "utf8");
			const state = JSON.parse(raw) as CheckpointState;
			this.lastPollTimestamp = state.lastPollTimestamp;
			return state.lastPollTimestamp;
		} catch (err) {
			if (isENOENT(err)) {
				// No checkpoint — fallback to current time
				const now = Date.now();
				this.lastPollTimestamp = now;
				return now;
			}
			logger.warn("Failed to load feed subscriber checkpoint", {
				error: String(err),
			});
			const now = Date.now();
			this.lastPollTimestamp = now;
			return now;
		}
	}

	private async saveCheckpoint(timestamp: number): Promise<void> {
		this.lastPollTimestamp = timestamp;
		const state: CheckpointState = { lastPollTimestamp: timestamp };
		const path = this.checkpointPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(state, null, 2), "utf8");
	}

	private checkpointPath(): string {
		return join(this.stateDir, "feed-subscriber-checkpoint.json");
	}
}
