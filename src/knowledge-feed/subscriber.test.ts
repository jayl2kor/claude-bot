/**
 * Tests for FeedSubscriber — polling, dedup, confidence reduction, checkpoint.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeManager } from "../memory/knowledge.js";
import { FeedStore } from "./feed-store.js";
import { FeedSubscriber } from "./subscriber.js";
import type { FeedEntry } from "./types.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-sub-test-${randomUUID()}`);
}

function makeFeedEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
	return {
		id: randomUUID(),
		sourcePetId: "pet-a",
		originalKnowledgeId: randomUUID(),
		topic: "test topic",
		content: "test content",
		confidence: 0.85,
		source: "taught",
		tags: ["test"],
		publishedAt: Date.now(),
		...overrides,
	};
}

describe("FeedSubscriber", () => {
	let feedDir: string;
	let knowledgeDir: string;
	let stateDir: string;
	let feedStore: FeedStore;
	let knowledge: KnowledgeManager;
	let subscriber: FeedSubscriber;

	/** Create a subscriber with checkpoint initialized to 0 (picks up all entries). */
	async function createSubscriberWithCheckpoint(
		checkpoint = 0,
	): Promise<FeedSubscriber> {
		// Write an initial checkpoint so the subscriber starts from a known point
		await writeFile(
			join(stateDir, "feed-subscriber-checkpoint.json"),
			JSON.stringify({ lastPollTimestamp: checkpoint }),
			"utf8",
		);
		return new FeedSubscriber({
			feedStore,
			knowledge,
			petId: "pet-b",
			stateDir,
			confidenceMultiplier: 0.7,
		});
	}

	beforeEach(async () => {
		feedDir = makeTempDir();
		knowledgeDir = makeTempDir();
		stateDir = makeTempDir();
		await mkdir(feedDir, { recursive: true });
		await mkdir(knowledgeDir, { recursive: true });
		await mkdir(stateDir, { recursive: true });
		feedStore = new FeedStore(feedDir);
		knowledge = new KnowledgeManager(knowledgeDir);
		// Default subscriber with checkpoint at 0 so tests can write entries with Date.now()
		subscriber = await createSubscriberWithCheckpoint(0);
	});

	// -------------------------------------------------------------------------
	// poll
	// -------------------------------------------------------------------------

	describe("poll", () => {
		it("imports new feed entries as local knowledge", async () => {
			const entry = makeFeedEntry({
				publishedAt: Date.now(),
				topic: "TypeScript immutability",
				content: "Use readonly arrays for safety",
				confidence: 0.85,
			});
			await feedStore.write(entry);

			const result = await subscriber.poll();
			expect(result.imported).toBe(1);
			expect(result.skipped).toBe(0);

			// Verify knowledge was created
			const all = await knowledge.listAll();
			expect(all).toHaveLength(1);
			expect(all[0]!.topic).toBe("TypeScript immutability");
			expect(all[0]!.source).toBe("propagated");
		});

		it("skips entries from the same pet (self-propagation)", async () => {
			const entry = makeFeedEntry({
				sourcePetId: "pet-b", // same as subscriber's petId
				publishedAt: Date.now(),
			});
			await feedStore.write(entry);

			const result = await subscriber.poll();
			expect(result.imported).toBe(0);
			expect(result.skipped).toBe(1);
		});

		it("skips entries when topic already exists in local knowledge", async () => {
			// First, add existing knowledge with the same topic
			await knowledge.upsert({
				id: randomUUID(),
				topic: "existing topic",
				content: "already known",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.9,
				tags: [],
			});

			const entry = makeFeedEntry({
				topic: "existing topic",
				content: "different content but same topic",
				publishedAt: Date.now(),
			});
			await feedStore.write(entry);

			const result = await subscriber.poll();
			expect(result.imported).toBe(0);
			expect(result.skipped).toBe(1);
		});

		it("applies confidence multiplier (x0.7)", async () => {
			const entry = makeFeedEntry({
				confidence: 0.85,
				publishedAt: Date.now(),
			});
			await feedStore.write(entry);

			await subscriber.poll();

			const all = await knowledge.listAll();
			expect(all).toHaveLength(1);
			// 0.85 * 0.7 = 0.595
			expect(all[0]!.confidence).toBeCloseTo(0.595, 3);
		});

		it("sets source to 'propagated' on imported entries", async () => {
			const entry = makeFeedEntry({ publishedAt: Date.now() });
			await feedStore.write(entry);

			await subscriber.poll();

			const all = await knowledge.listAll();
			expect(all).toHaveLength(1);
			expect(all[0]!.source).toBe("propagated");
		});

		it("does not re-import entries on subsequent polls (checkpoint)", async () => {
			const entry = makeFeedEntry({ publishedAt: Date.now() });
			await feedStore.write(entry);

			const first = await subscriber.poll();
			expect(first.imported).toBe(1);

			const second = await subscriber.poll();
			expect(second.imported).toBe(0);
			expect(second.skipped).toBe(0);
		});

		it("imports only new entries after checkpoint", async () => {
			const old = makeFeedEntry({ publishedAt: 1000, topic: "old topic" });
			await feedStore.write(old);
			await subscriber.poll();

			const newer = makeFeedEntry({
				publishedAt: Date.now() + 1000,
				topic: "new topic",
			});
			await feedStore.write(newer);

			const result = await subscriber.poll();
			expect(result.imported).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// checkpoint persistence
	// -------------------------------------------------------------------------

	describe("checkpoint persistence", () => {
		it("saves and loads checkpoint state across instances", async () => {
			const entry = makeFeedEntry({ publishedAt: Date.now() });
			await feedStore.write(entry);

			await subscriber.poll();

			// Create a new subscriber with the same state dir
			const newSubscriber = new FeedSubscriber({
				feedStore,
				knowledge,
				petId: "pet-b",
				stateDir,
				confidenceMultiplier: 0.7,
			});

			// Should not re-import the same entry
			const result = await newSubscriber.poll();
			expect(result.imported).toBe(0);
		});

		it("falls back to current time when no checkpoint exists", async () => {
			// Write an entry in the past
			const pastEntry = makeFeedEntry({ publishedAt: Date.now() - 60_000 });
			await feedStore.write(pastEntry);

			// New subscriber with fresh state dir should not pick up old entries
			const freshStateDir = makeTempDir();
			await mkdir(freshStateDir, { recursive: true });
			const freshSubscriber = new FeedSubscriber({
				feedStore,
				knowledge,
				petId: "pet-b",
				stateDir: freshStateDir,
				confidenceMultiplier: 0.7,
			});

			const result = await freshSubscriber.poll();
			// Old entries before subscriber creation should be skipped
			expect(result.imported).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// metadata
	// -------------------------------------------------------------------------

	describe("metadata", () => {
		it("sets propagatedFrom metadata on imported knowledge", async () => {
			const entry = makeFeedEntry({
				sourcePetId: "pet-a",
				publishedAt: Date.now(),
			});
			await feedStore.write(entry);

			await subscriber.poll();

			const all = await knowledge.listAll();
			expect(all).toHaveLength(1);
			expect(all[0]!.propagatedFrom).toBe("pet-a");
		});
	});
});
