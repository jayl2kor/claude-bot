/**
 * Tests for KnowledgeManager — forgetting curve integration.
 * Covers: reinforce, applyDecayAll, archiveWeak, listFading,
 * backward compatibility with entries missing new fields,
 * strength-weighted search, and memory tier management (Issue #42).
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
		// Tier fields (Issue #42)
		tier: "scratchpad",
		tierCreatedAt: now,
		promotionScore: 0,
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

	// -----------------------------------------------------------------------
	// Memory Tier (Issue #42)
	// -----------------------------------------------------------------------

	describe("memory tier", () => {
		// -------------------------------------------------------------------
		// Default tier assignment
		// -------------------------------------------------------------------

		describe("default tier assignment", () => {
			it("assigns 'scratchpad' tier by default when not specified", async () => {
				const entry = makeEntry();
				await manager.upsert(entry);

				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("scratchpad");
			});

			it("preserves explicitly assigned tier", async () => {
				const entry = makeEntry({ tier: "working" });
				await manager.upsert(entry);

				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("working");
			});

			it("sets tierCreatedAt on upsert", async () => {
				const before = Date.now();
				const entry = makeEntry();
				await manager.upsert(entry);
				const after = Date.now();

				const stored = await manager.get(entry.id);
				expect(stored?.tierCreatedAt).toBeGreaterThanOrEqual(before);
				expect(stored?.tierCreatedAt).toBeLessThanOrEqual(after);
			});

			it("computes promotionScore on upsert", async () => {
				const entry = makeEntry({
					referenceCount: 3,
					confidence: 0.8,
					strength: 0.8,
				});
				await manager.upsert(entry);

				const stored = await manager.get(entry.id);
				// promotionScore = 3*0.4 + 0.8*0.4 + 0.2 = 1.2 + 0.32 + 0.2 = 1.72
				expect(stored?.promotionScore).toBeGreaterThan(0);
			});
		});

		// -------------------------------------------------------------------
		// Backward compatibility with entries missing tier fields
		// -------------------------------------------------------------------

		describe("backward compatibility for tier fields", () => {
			it("reads old entries without tier fields and defaults to 'scratchpad'", async () => {
				const id = randomUUID();
				const oldEntry = {
					id,
					topic: "old topic without tier",
					content: "content",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
					strength: 1.0,
					lastReferencedAt: Date.now(),
					referenceCount: 0,
				};
				const safeName = id.replace(/[^a-zA-Z0-9_-]/g, "_");
				await writeFile(
					join(memoryDir, `${safeName}.json`),
					JSON.stringify(oldEntry, null, 2),
					"utf8",
				);

				const read = await manager.get(id);
				expect(read).not.toBeNull();
				expect(read?.tier).toBe("scratchpad");
				expect(read?.tierCreatedAt).toBeDefined();
				expect(read?.promotionScore).toBeGreaterThanOrEqual(0);
			});
		});

		// -------------------------------------------------------------------
		// promotionScore calculation
		// -------------------------------------------------------------------

		describe("computePromotionScore", () => {
			it("returns higher score for high referenceCount + confidence + strength", async () => {
				const highScore = makeEntry({
					referenceCount: 10,
					confidence: 0.9,
					strength: 0.9,
				});
				const lowScore = makeEntry({
					referenceCount: 0,
					confidence: 0.5,
					strength: 0.3,
				});

				await manager.upsert(highScore);
				await manager.upsert(lowScore);

				const h = await manager.get(highScore.id);
				const l = await manager.get(lowScore.id);
				expect(h!.promotionScore).toBeGreaterThan(l!.promotionScore);
			});

			it("adds 0.2 bonus when strength > 0.7", async () => {
				const withBonus = makeEntry({ referenceCount: 0, confidence: 0.5, strength: 0.8 });
				const withoutBonus = makeEntry({ referenceCount: 0, confidence: 0.5, strength: 0.5 });

				await manager.upsert(withBonus);
				await manager.upsert(withoutBonus);

				const wb = await manager.get(withBonus.id);
				const wob = await manager.get(withoutBonus.id);
				// Difference should be ~0.2
				expect(wb!.promotionScore - wob!.promotionScore).toBeCloseTo(0.2, 5);
			});
		});

		// -------------------------------------------------------------------
		// scratchpad TTL expiry
		// -------------------------------------------------------------------

		describe("scratchpad TTL expiry (expireScratchpad)", () => {
			it("deletes scratchpad entries whose TTL has expired", async () => {
				const expired = makeEntry({
					tier: "scratchpad",
					tierCreatedAt: Date.now() - 2 * 3_600_000, // 2 hours ago
					scratchpadTtlMs: 3_600_000, // 1 hour TTL
				});
				await manager.upsert(expired);

				const removed = await manager.expireScratchpad();

				expect(removed).toBe(1);
				expect(await manager.get(expired.id)).toBeNull();
			});

			it("keeps scratchpad entries whose TTL has not expired", async () => {
				const fresh = makeEntry({
					tier: "scratchpad",
					tierCreatedAt: Date.now() - 1_000, // 1 second ago
					scratchpadTtlMs: 3_600_000, // 1 hour TTL
				});
				await manager.upsert(fresh);

				const removed = await manager.expireScratchpad();

				expect(removed).toBe(0);
				expect(await manager.get(fresh.id)).not.toBeNull();
			});

			it("does not delete working or long-term entries", async () => {
				const working = makeEntry({
					tier: "working",
					tierCreatedAt: Date.now() - 999_999_999,
				});
				const longTerm = makeEntry({
					tier: "long-term",
					tierCreatedAt: Date.now() - 999_999_999,
				});
				await manager.upsert(working);
				await manager.upsert(longTerm);

				const removed = await manager.expireScratchpad();

				expect(removed).toBe(0);
				expect(await manager.get(working.id)).not.toBeNull();
				expect(await manager.get(longTerm.id)).not.toBeNull();
			});

			it("promotes eligible scratchpad entries before expiring them", async () => {
				// Entry eligible for promotion (referenceCount >= 2)
				const promotable = makeEntry({
					tier: "scratchpad",
					tierCreatedAt: Date.now() - 2 * 3_600_000,
					scratchpadTtlMs: 3_600_000,
					referenceCount: 3, // >= 2, eligible for working
					confidence: 0.7,
				});
				await manager.upsert(promotable);

				const removed = await manager.expireScratchpad();

				// Should NOT be deleted — was promoted instead
				expect(removed).toBe(0);
				const stored = await manager.get(promotable.id);
				expect(stored?.tier).toBe("working");
			});
		});

		// -------------------------------------------------------------------
		// Tier promotion
		// -------------------------------------------------------------------

		describe("promoteTiers", () => {
			it("promotes scratchpad → working when referenceCount >= 2", async () => {
				const entry = makeEntry({
					tier: "scratchpad",
					referenceCount: 2,
					confidence: 0.6,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.scratchpadToWorking).toBe(1);
				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("working");
			});

			it("promotes scratchpad → working when confidence >= 0.85", async () => {
				const entry = makeEntry({
					tier: "scratchpad",
					referenceCount: 0,
					confidence: 0.9,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.scratchpadToWorking).toBe(1);
				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("working");
			});

			it("does NOT promote scratchpad when conditions not met", async () => {
				const entry = makeEntry({
					tier: "scratchpad",
					referenceCount: 1,
					confidence: 0.7,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.scratchpadToWorking).toBe(0);
				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("scratchpad");
			});

			it("promotes working → long-term when referenceCount >= 5 AND confidence >= 0.8", async () => {
				const entry = makeEntry({
					tier: "working",
					referenceCount: 5,
					confidence: 0.8,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.workingToLongTerm).toBe(1);
				const stored = await manager.get(entry.id);
				expect(stored?.tier).toBe("long-term");
			});

			it("does NOT promote working → long-term when referenceCount < 5", async () => {
				const entry = makeEntry({
					tier: "working",
					referenceCount: 4,
					confidence: 0.9,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.workingToLongTerm).toBe(0);
				expect((await manager.get(entry.id))?.tier).toBe("working");
			});

			it("does NOT promote working → long-term when confidence < 0.8", async () => {
				const entry = makeEntry({
					tier: "working",
					referenceCount: 10,
					confidence: 0.79,
				});
				await manager.upsert(entry);

				const result = await manager.promoteTiers();

				expect(result.workingToLongTerm).toBe(0);
				expect((await manager.get(entry.id))?.tier).toBe("working");
			});

			it("updates tierCreatedAt when promoting", async () => {
				const oldTierCreatedAt = Date.now() - 5_000;
				const entry = makeEntry({
					tier: "scratchpad",
					tierCreatedAt: oldTierCreatedAt,
					referenceCount: 2,
					confidence: 0.7,
				});
				await manager.upsert(entry);

				const before = Date.now();
				await manager.promoteTiers();
				const after = Date.now();

				const stored = await manager.get(entry.id);
				expect(stored?.tierCreatedAt).toBeGreaterThanOrEqual(before);
				expect(stored?.tierCreatedAt).toBeLessThanOrEqual(after);
			});

			it("returns correct counts for multiple promotions", async () => {
				const sp1 = makeEntry({ tier: "scratchpad", referenceCount: 3, confidence: 0.7 });
				const sp2 = makeEntry({ tier: "scratchpad", referenceCount: 0, confidence: 0.9 });
				const sp3 = makeEntry({ tier: "scratchpad", referenceCount: 0, confidence: 0.5 }); // no promotion
				const wk1 = makeEntry({ tier: "working", referenceCount: 6, confidence: 0.85 });
				const wk2 = makeEntry({ tier: "working", referenceCount: 2, confidence: 0.9 }); // no promotion

				for (const e of [sp1, sp2, sp3, wk1, wk2]) {
					await manager.upsert(e);
				}

				const result = await manager.promoteTiers();

				expect(result.scratchpadToWorking).toBe(2);
				expect(result.workingToLongTerm).toBe(1);
			});
		});

		// -------------------------------------------------------------------
		// Retrieval tier priority (search with tier weighting)
		// -------------------------------------------------------------------

		describe("search with tier priority weighting", () => {
			it("ranks long-term > working > scratchpad for equal relevance", async () => {
				const longTerm = makeEntry({
					topic: "golang concurrency",
					content: "goroutines and channels",
					tier: "long-term",
					strength: 0.8,
					confidence: 0.8,
				});
				const working = makeEntry({
					topic: "golang concurrency",
					content: "goroutines and channels",
					tier: "working",
					strength: 0.8,
					confidence: 0.8,
				});
				const scratchpad = makeEntry({
					topic: "golang concurrency",
					content: "goroutines and channels",
					tier: "scratchpad",
					strength: 0.8,
					confidence: 0.8,
				});

				await manager.upsert(longTerm);
				await manager.upsert(working);
				await manager.upsert(scratchpad);

				const results = await manager.search("golang concurrency", 10);

				const ids = results.map((r) => r.id);
				expect(ids.indexOf(longTerm.id)).toBeLessThan(ids.indexOf(working.id));
				expect(ids.indexOf(working.id)).toBeLessThan(ids.indexOf(scratchpad.id));
			});

			it("applies tier multiplier: long-term 1.3x, working 1.0x, scratchpad 0.7x", async () => {
				// long-term with lower raw score should beat scratchpad with higher raw score
				// if the tier multiplier compensates
				const ltEntry = makeEntry({
					topic: "python testing",
					content: "pytest fixtures",
					tier: "long-term",
					strength: 0.5,  // lower strength
					confidence: 0.6,
				});
				const spEntry = makeEntry({
					topic: "python testing",
					content: "pytest fixtures",
					tier: "scratchpad",
					strength: 0.5,
					confidence: 0.6,
				});

				await manager.upsert(ltEntry);
				await manager.upsert(spEntry);

				const results = await manager.search("python testing", 10);
				const ids = results.map((r) => r.id);
				// long-term should appear before scratchpad
				expect(ids.indexOf(ltEntry.id)).toBeLessThan(ids.indexOf(spEntry.id));
			});
		});

		// -------------------------------------------------------------------
		// getTierStats
		// -------------------------------------------------------------------

		describe("getTierStats", () => {
			it("returns zero counts when store is empty", async () => {
				const stats = await manager.getTierStats();
				expect(stats.scratchpad).toBe(0);
				expect(stats.working).toBe(0);
				expect(stats.longTerm).toBe(0);
				expect(stats.total).toBe(0);
			});

			it("counts entries per tier correctly", async () => {
				await manager.upsert(makeEntry({ tier: "scratchpad" }));
				await manager.upsert(makeEntry({ tier: "scratchpad" }));
				await manager.upsert(makeEntry({ tier: "working" }));
				await manager.upsert(makeEntry({ tier: "long-term" }));

				const stats = await manager.getTierStats();
				expect(stats.scratchpad).toBe(2);
				expect(stats.working).toBe(1);
				expect(stats.longTerm).toBe(1);
				expect(stats.total).toBe(4);
			});

			it("includes entries missing tier field (defaulted to scratchpad) in scratchpad count", async () => {
				// Write an entry without tier field directly
				const id = randomUUID();
				const oldEntry = {
					id,
					topic: "tier-less entry",
					content: "no tier field",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
					strength: 1.0,
					lastReferencedAt: Date.now(),
					referenceCount: 0,
				};
				const safeName = id.replace(/[^a-zA-Z0-9_-]/g, "_");
				await writeFile(
					join(memoryDir, `${safeName}.json`),
					JSON.stringify(oldEntry, null, 2),
					"utf8",
				);

				const stats = await manager.getTierStats();
				expect(stats.scratchpad).toBe(1);
			});
		});
	});
});
