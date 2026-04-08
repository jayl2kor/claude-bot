/**
 * Tests for FeedStore — CRUD, listSince, findExpired, atomic write.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedStore } from "./feed-store.js";
import type { FeedEntry } from "./types.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-feed-test-${randomUUID()}`);
}

function makeEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
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

describe("FeedStore", () => {
	let dir: string;
	let store: FeedStore;

	beforeEach(async () => {
		dir = makeTempDir();
		await mkdir(dir, { recursive: true });
		store = new FeedStore(dir);
	});

	// -------------------------------------------------------------------------
	// write + read
	// -------------------------------------------------------------------------

	describe("write and read", () => {
		it("writes and reads back a feed entry", async () => {
			const entry = makeEntry();
			await store.write(entry);
			const read = await store.read(entry.id);
			expect(read).toEqual(entry);
		});

		it("returns null for non-existent entry", async () => {
			const result = await store.read("nonexistent");
			expect(result).toBeNull();
		});

		it("creates the directory if it does not exist", async () => {
			const nestedDir = join(dir, "nested", "deep");
			const nestedStore = new FeedStore(nestedDir);
			const entry = makeEntry();
			await nestedStore.write(entry);
			const read = await nestedStore.read(entry.id);
			expect(read).toEqual(entry);
		});

		it("uses entry id as filename (UUID, no conflicts)", async () => {
			const entry = makeEntry();
			await store.write(entry);
			const files = await readdir(dir);
			expect(files).toContain(`${entry.id}.json`);
		});
	});

	// -------------------------------------------------------------------------
	// remove
	// -------------------------------------------------------------------------

	describe("remove", () => {
		it("removes an existing entry", async () => {
			const entry = makeEntry();
			await store.write(entry);
			await store.remove(entry.id);
			const read = await store.read(entry.id);
			expect(read).toBeNull();
		});

		it("does not throw when removing non-existent entry", async () => {
			await expect(store.remove("ghost")).resolves.not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// listSince
	// -------------------------------------------------------------------------

	describe("listSince", () => {
		it("returns entries published after the given timestamp", async () => {
			const old = makeEntry({ publishedAt: 1000 });
			const recent = makeEntry({ publishedAt: 3000 });
			await store.write(old);
			await store.write(recent);

			const results = await store.listSince(2000);
			expect(results).toHaveLength(1);
			expect(results[0]!.id).toBe(recent.id);
		});

		it("returns empty array when no entries match", async () => {
			const old = makeEntry({ publishedAt: 1000 });
			await store.write(old);

			const results = await store.listSince(5000);
			expect(results).toEqual([]);
		});

		it("returns empty array for empty store", async () => {
			const results = await store.listSince(0);
			expect(results).toEqual([]);
		});

		it("returns entries sorted by publishedAt ascending", async () => {
			const a = makeEntry({ publishedAt: 3000 });
			const b = makeEntry({ publishedAt: 1000 });
			const c = makeEntry({ publishedAt: 2000 });
			await store.write(a);
			await store.write(b);
			await store.write(c);

			const results = await store.listSince(0);
			expect(results.map((e) => e.publishedAt)).toEqual([1000, 2000, 3000]);
		});
	});

	// -------------------------------------------------------------------------
	// findExpired
	// -------------------------------------------------------------------------

	describe("findExpired", () => {
		it("returns entries older than the TTL", async () => {
			const now = Date.now();
			const expired = makeEntry({ publishedAt: now - 10_000 });
			const fresh = makeEntry({ publishedAt: now - 1_000 });
			await store.write(expired);
			await store.write(fresh);

			const results = await store.findExpired(5_000);
			expect(results).toHaveLength(1);
			expect(results[0]!.id).toBe(expired.id);
		});

		it("returns empty array when nothing is expired", async () => {
			const fresh = makeEntry({ publishedAt: Date.now() });
			await store.write(fresh);

			const results = await store.findExpired(60_000);
			expect(results).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// atomic writes
	// -------------------------------------------------------------------------

	describe("atomic writes", () => {
		it("handles concurrent writes without corruption", async () => {
			const entries = Array.from({ length: 20 }, () => makeEntry());
			await Promise.all(entries.map((e) => store.write(e)));

			for (const entry of entries) {
				const read = await store.read(entry.id);
				expect(read).toEqual(entry);
			}
		});
	});
});
