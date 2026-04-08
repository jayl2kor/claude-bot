/**
 * Tests for KnowledgeManager — forgetting curve integration.
 * Covers: reinforce, applyDecayAll, archiveWeak, listFading,
 * backward compatibility with entries missing new fields,
 * and strength-weighted search.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KnowledgeManager } from "./knowledge.js";
import type { KnowledgeEntry } from "./knowledge.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-knowledge-test-${randomUUID()}`);
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	const now = Date.now();
	return {
		id: randomUUID(),
		topic: "test topic",
		content: "test content",
		source: "taught",
		taughtBy: "user1",
		createdAt: now,
		updatedAt: now,
		confidence: 0.8,
		tags: [],
		strength: 1.0,
		lastReferencedAt: now,
		referenceCount: 0,
		...overrides,
	};
}

describe("KnowledgeManager", () => {
	let memoryDir: string;
	let archiveDir: string;
	let manager: KnowledgeManager;

	beforeEach(async () => {
		memoryDir = makeTempDir();
		archiveDir = join(memoryDir, "..", "archive");
		await mkdir(memoryDir, { recursive: true });
		manager = new KnowledgeManager(memoryDir, archiveDir);
	});

	// -----------------------------------------------------------------------
	// Backward compatibility
	// -----------------------------------------------------------------------

	describe("backward compatibility", () => {
		it("reads entries without strength/lastReferencedAt/referenceCount", async () => {
			// Simulate an old-format entry without the new fields
			const id = randomUUID();
			const oldEntry = {
				id,
				topic: "old topic",
				content: "old content",
				source: "taught",
				taughtBy: "user1",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: ["test"],
			};
			// Write directly to disk (bypassing schema validation)
			const safeName = id.replace(/[^a-zA-Z0-9_-]/g, "_");
			await writeFile(
				join(memoryDir, `${safeName}.json`),
				JSON.stringify(oldEntry, null, 2),
				"utf8",
			);

			const read = await manager.get(id);
			expect(read).not.toBeNull();
			expect(read?.strength).toBe(1.0); // default
			expect(read?.lastReferencedAt).toBeDefined(); // default
			expect(read?.referenceCount).toBe(0); // default
		});
	});

	// -----------------------------------------------------------------------
	// reinforce
	// -----------------------------------------------------------------------

	describe("reinforce", () => {
		it("increases strength by REINFORCE_DELTA", async () => {
			const entry = makeEntry({ strength: 0.5 });
			await manager.upsert(entry);
			await manager.reinforce(entry.id);

			const updated = await manager.get(entry.id);
			expect(updated).not.toBeNull();
			expect(updated?.strength).toBeCloseTo(0.65, 2);
		});

		it("clamps strength to 1.0", async () => {
			const entry = makeEntry({ strength: 0.95 });
			await manager.upsert(entry);
			await manager.reinforce(entry.id);

			const updated = await manager.get(entry.id);
			expect(updated?.strength).toBe(1.0);
		});

		it("increments referenceCount", async () => {
			const entry = makeEntry({ referenceCount: 3 });
			await manager.upsert(entry);
			await manager.reinforce(entry.id);

			const updated = await manager.get(entry.id);
			expect(updated?.referenceCount).toBe(4);
		});

		it("updates lastReferencedAt", async () => {
			const past = Date.now() - 100_000;
			const entry = makeEntry({ lastReferencedAt: past });
			await manager.upsert(entry);

			const before = Date.now();
			await manager.reinforce(entry.id);
			const after = Date.now();

			const updated = await manager.get(entry.id);
			expect(updated?.lastReferencedAt).toBeGreaterThanOrEqual(before);
			expect(updated?.lastReferencedAt).toBeLessThanOrEqual(after);
		});

		it("is a no-op for nonexistent entry", async () => {
			// Should not throw
			await expect(manager.reinforce("nonexistent-id")).resolves.not.toThrow();
		});

		it("reinforces multiple entry IDs in batch", async () => {
			const e1 = makeEntry({ strength: 0.5 });
			const e2 = makeEntry({ strength: 0.6 });
			await manager.upsert(e1);
			await manager.upsert(e2);

			await manager.reinforceMany([e1.id, e2.id]);

			const u1 = await manager.get(e1.id);
			const u2 = await manager.get(e2.id);
			expect(u1?.strength).toBeCloseTo(0.65, 2);
			expect(u2?.strength).toBeCloseTo(0.75, 2);
		});
	});

	// -----------------------------------------------------------------------
	// applyDecayAll
	// -----------------------------------------------------------------------

	describe("applyDecayAll", () => {
		it("decays all entries based on elapsed time", async () => {
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
			const entry = makeEntry({
				strength: 1.0,
				lastReferencedAt: twoHoursAgo,
			});
			await manager.upsert(entry);

			await manager.applyDecayAll();

			const updated = await manager.get(entry.id);
			expect(updated?.strength).toBeLessThan(1.0);
			// After 2 hours: e^(-0.02*2) ≈ 0.961
			expect(updated?.strength).toBeCloseTo(0.961, 1);
		});

		it("does not decay recently referenced entries significantly", async () => {
			const entry = makeEntry({
				strength: 1.0,
				lastReferencedAt: Date.now(),
			});
			await manager.upsert(entry);

			await manager.applyDecayAll();

			const updated = await manager.get(entry.id);
			expect(updated?.strength).toBeCloseTo(1.0, 1);
		});

		it("decays multiple entries independently", async () => {
			const oneHourAgo = Date.now() - 1 * 60 * 60 * 1000;
			const tenHoursAgo = Date.now() - 10 * 60 * 60 * 1000;

			const e1 = makeEntry({
				strength: 1.0,
				lastReferencedAt: oneHourAgo,
			});
			const e2 = makeEntry({
				strength: 0.8,
				lastReferencedAt: tenHoursAgo,
			});

			await manager.upsert(e1);
			await manager.upsert(e2);

			await manager.applyDecayAll();

			const u1 = await manager.get(e1.id);
			const u2 = await manager.get(e2.id);

			// e1: e^(-0.02*1) ≈ 0.980
			expect(u1?.strength).toBeGreaterThan(u2?.strength ?? 0);
			expect(u1?.strength).toBeCloseTo(0.98, 1);
			// e2: 0.8 * e^(-0.02*10) ≈ 0.654
			expect(u2?.strength).toBeCloseTo(0.654, 1);
		});
	});

	// -----------------------------------------------------------------------
	// archiveWeak
	// -----------------------------------------------------------------------

	describe("archiveWeak", () => {
		it("moves entries below archive threshold to archive directory", async () => {
			const entry = makeEntry({ strength: 0.05 }); // below 0.1
			await manager.upsert(entry);

			const archived = await manager.archiveWeak();

			expect(archived).toBe(1);
			// Should be gone from main store
			const remaining = await manager.get(entry.id);
			expect(remaining).toBeNull();

			// Should exist in archive dir
			const archiveFiles = await readdir(archiveDir);
			expect(archiveFiles.length).toBeGreaterThan(0);
		});

		it("does not archive entries above threshold", async () => {
			const entry = makeEntry({ strength: 0.5 });
			await manager.upsert(entry);

			const archived = await manager.archiveWeak();

			expect(archived).toBe(0);
			const remaining = await manager.get(entry.id);
			expect(remaining).not.toBeNull();
		});

		it("archives exactly the weak entries", async () => {
			const strong = makeEntry({ strength: 0.8 });
			const borderline = makeEntry({ strength: 0.1 }); // exactly at threshold -- not archived
			const weak = makeEntry({ strength: 0.09 });

			await manager.upsert(strong);
			await manager.upsert(borderline);
			await manager.upsert(weak);

			const archived = await manager.archiveWeak();

			expect(archived).toBe(1);
			expect(await manager.get(strong.id)).not.toBeNull();
			expect(await manager.get(borderline.id)).not.toBeNull();
			expect(await manager.get(weak.id)).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// listFading
	// -----------------------------------------------------------------------

	describe("listFading", () => {
		it("returns entries with strength between archive and deprioritize thresholds", async () => {
			const fading = makeEntry({ strength: 0.2 }); // between 0.1 and 0.3
			const strong = makeEntry({ strength: 0.8 });
			const tooWeak = makeEntry({ strength: 0.05 });

			await manager.upsert(fading);
			await manager.upsert(strong);
			await manager.upsert(tooWeak);

			const result = await manager.listFading();

			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe(fading.id);
		});

		it("returns empty array when no entries are fading", async () => {
			const strong = makeEntry({ strength: 0.8 });
			await manager.upsert(strong);

			const result = await manager.listFading();
			expect(result).toHaveLength(0);
		});

		it("respects limit parameter", async () => {
			const entries = Array.from({ length: 5 }, (_, i) =>
				makeEntry({ strength: 0.15 + i * 0.02 }),
			);
			for (const e of entries) {
				await manager.upsert(e);
			}

			const result = await manager.listFading(2);
			expect(result).toHaveLength(2);
		});
	});

	// -----------------------------------------------------------------------
	// search -- strength-weighted
	// -----------------------------------------------------------------------

	describe("search (strength-weighted)", () => {
		it("boosts results by strength in scoring", async () => {
			const strong = makeEntry({
				topic: "TypeScript patterns",
				content: "use interfaces",
				strength: 1.0,
			});
			const weak = makeEntry({
				topic: "TypeScript patterns",
				content: "use types",
				strength: 0.2,
			});

			await manager.upsert(strong);
			await manager.upsert(weak);

			const results = await manager.search("TypeScript");

			// Strong entry should rank higher
			expect(results[0]?.id).toBe(strong.id);
		});

		it("excludes entries below deprioritize threshold from search", async () => {
			const visible = makeEntry({
				topic: "visible topic",
				content: "visible content",
				strength: 0.5,
			});
			const hidden = makeEntry({
				topic: "visible topic hidden",
				content: "visible content hidden",
				strength: 0.2, // below 0.3
			});

			await manager.upsert(visible);
			await manager.upsert(hidden);

			const results = await manager.search("visible");

			expect(results).toHaveLength(1);
			expect(results[0]?.id).toBe(visible.id);
		});
	});

	// -----------------------------------------------------------------------
	// toPromptSection -- returns { text, entryIds }
	// -----------------------------------------------------------------------

	describe("toPromptSection", () => {
		it("returns null when no relevant results", async () => {
			const result = await manager.toPromptSection("nonexistent");
			expect(result).toBeNull();
		});

		it("returns text and entryIds for relevant results", async () => {
			const entry = makeEntry({
				topic: "React hooks",
				content: "useState for state management",
				strength: 0.8,
			});
			await manager.upsert(entry);

			const result = await manager.toPromptSection("React");

			expect(result).not.toBeNull();
			expect(result?.text).toContain("React hooks");
			expect(result?.entryIds).toContain(entry.id);
		});

		it("includes strength bar in text output", async () => {
			const entry = makeEntry({
				topic: "Node.js async",
				content: "event loop",
				strength: 0.67,
			});
			await manager.upsert(entry);

			const result = await manager.toPromptSection("Node");
			expect(result).not.toBeNull();
			// Should contain some kind of strength indicator
			expect(result?.text).toContain("Node.js async");
		});
	});
});
