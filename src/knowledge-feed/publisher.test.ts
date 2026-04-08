/**
 * Tests for FeedPublisher — publish logic and propagated skip.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedStore } from "./feed-store.js";
import { FeedPublisher } from "./publisher.js";
import type { FeedEntry } from "./types.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-pub-test-${randomUUID()}`);
}

describe("FeedPublisher", () => {
	let dir: string;
	let store: FeedStore;
	let publisher: FeedPublisher;

	beforeEach(async () => {
		dir = makeTempDir();
		await mkdir(dir, { recursive: true });
		store = new FeedStore(dir);
		publisher = new FeedPublisher(store, "pet-a");
	});

	it("publishes a knowledge entry to the feed store", async () => {
		const result = await publisher.publish({
			id: "k1",
			topic: "TypeScript tips",
			content: "Use readonly for immutability",
			confidence: 0.85,
			source: "taught",
			tags: ["typescript"],
		});

		expect(result).not.toBeNull();
		const entry = result!;
		expect(entry.sourcePetId).toBe("pet-a");
		expect(entry.originalKnowledgeId).toBe("k1");
		expect(entry.topic).toBe("TypeScript tips");
		expect(entry.content).toBe("Use readonly for immutability");
		expect(entry.confidence).toBe(0.85);
		expect(entry.tags).toEqual(["typescript"]);

		// Verify it's in the store
		const stored = await store.read(entry.id);
		expect(stored).toEqual(entry);
	});

	it("skips entries with source 'propagated' to prevent infinite loops", async () => {
		const result = await publisher.publish({
			id: "k2",
			topic: "Propagated knowledge",
			content: "This was already propagated",
			confidence: 0.6,
			source: "propagated",
			tags: [],
		});

		expect(result).toBeNull();

		// Verify nothing was written
		const entries = await store.listSince(0);
		expect(entries).toHaveLength(0);
	});

	it("generates a unique ID for each feed entry", async () => {
		const r1 = await publisher.publish({
			id: "k1",
			topic: "A",
			content: "Content A",
			confidence: 0.8,
			source: "taught",
			tags: [],
		});

		const r2 = await publisher.publish({
			id: "k2",
			topic: "B",
			content: "Content B",
			confidence: 0.8,
			source: "taught",
			tags: [],
		});

		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();
		expect(r1!.id).not.toBe(r2!.id);
	});

	it("sets publishedAt to current time", async () => {
		const before = Date.now();
		const result = await publisher.publish({
			id: "k1",
			topic: "Topic",
			content: "Content",
			confidence: 0.8,
			source: "taught",
			tags: [],
		});
		const after = Date.now();

		expect(result).not.toBeNull();
		expect(result!.publishedAt).toBeGreaterThanOrEqual(before);
		expect(result!.publishedAt).toBeLessThanOrEqual(after);
	});

	it("allows 'corrected' source entries", async () => {
		const result = await publisher.publish({
			id: "k1",
			topic: "Corrected topic",
			content: "Fixed content",
			confidence: 0.95,
			source: "corrected",
			tags: [],
		});

		expect(result).not.toBeNull();
		expect(result!.source).toBe("corrected");
	});

	it("allows 'inferred' source entries", async () => {
		const result = await publisher.publish({
			id: "k1",
			topic: "Inferred topic",
			content: "Inferred content",
			confidence: 0.7,
			source: "inferred",
			tags: [],
		});

		expect(result).not.toBeNull();
		expect(result!.source).toBe("inferred");
	});
});
