/**
 * Tests for conflict-aware knowledge storage (Issue #43).
 *
 * Covers:
 * - detectConflicts: topic/similarity-based conflict detection
 * - saveWithRelation: storing entries with supersedes/refutes links
 * - getCanonical: canonical selection and history separation
 * - upsertWithConflictDetection: auto-detect and store with relations
 * - search exclusion of superseded entries
 * - Regression: conflicting info preserves original history
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeRelation } from "./knowledge.js";
import { KnowledgeManager } from "./knowledge.js";
import type { KnowledgeEntry } from "./knowledge.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-conflict-test-${randomUUID()}`);
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
		tier: "scratchpad",
		tierCreatedAt: now,
		promotionScore: 0,
		relations: [],
		...overrides,
	};
}

describe("Conflict-aware knowledge storage (Issue #43)", () => {
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
	// detectConflicts
	// -----------------------------------------------------------------------

	describe("detectConflicts", () => {
		it("returns empty result when no existing entries for topic", async () => {
			const result = await manager.detectConflicts("new topic", "some content");
			expect(result.conflictingIds).toHaveLength(0);
			expect(result.suggestedRelations).toHaveLength(0);
		});

		it("detects conflict when same-topic entry exists with similar content (supersedes)", async () => {
			const existing = makeEntry({
				topic: "Python best practices",
				content: "Use list comprehensions over map and filter for clarity",
				confidence: 0.8,
			});
			await manager.upsert(existing);

			// Overlapping content → supersedes
			const result = await manager.detectConflicts(
				"Python best practices",
				"Use list comprehensions instead of map and filter for readability",
			);

			expect(result.conflictingIds).toContain(existing.id);
			const suggestion = result.suggestedRelations.find(
				(r) => r.targetId === existing.id,
			);
			expect(suggestion?.type).toBe("supersedes");
		});

		it("detects conflict when same-topic entry exists with divergent content (refutes)", async () => {
			const existing = makeEntry({
				topic: "TypeScript null safety",
				content: "Always enable strictNullChecks in tsconfig",
				confidence: 0.8,
			});
			await manager.upsert(existing);

			// Completely different content on same topic → refutes
			const result = await manager.detectConflicts(
				"TypeScript null safety",
				"Disable strictNullChecks to avoid verbose null checks",
			);

			expect(result.conflictingIds).toContain(existing.id);
			const suggestion = result.suggestedRelations.find(
				(r) => r.targetId === existing.id,
			);
			expect(suggestion?.type).toBe("refutes");
		});

		it("excludes already-superseded entries from conflict detection", async () => {
			const old = makeEntry({
				topic: "React state",
				content: "Use setState to update component state",
				supersededBy: "newer-id",
			});
			await manager.upsert(old);

			const result = await manager.detectConflicts(
				"React state",
				"Use useState hook to manage component state",
			);

			// The superseded entry should be skipped
			expect(result.conflictingIds).not.toContain(old.id);
		});

		it("detects multiple conflicts when multiple active entries exist on same topic", async () => {
			const e1 = makeEntry({
				topic: "database indexing",
				content: "Add index on frequently queried columns",
			});
			const e2 = makeEntry({
				topic: "database indexing",
				content: "Use composite index for multi-column queries",
			});
			await manager.upsert(e1);
			await manager.upsert(e2);

			const result = await manager.detectConflicts(
				"database indexing",
				"Index only the most critical columns to avoid write overhead",
			);

			// At least one conflict detected
			expect(result.conflictingIds.length).toBeGreaterThan(0);
		});

		it("no conflict when topic differs entirely", async () => {
			const existing = makeEntry({
				topic: "Go routines",
				content: "Use goroutines for concurrent tasks",
			});
			await manager.upsert(existing);

			const result = await manager.detectConflicts(
				"Python async",
				"Use asyncio for async programming",
			);

			expect(result.conflictingIds).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// saveWithRelation
	// -----------------------------------------------------------------------

	describe("saveWithRelation", () => {
		it("stores new entry with supersedes relation and marks target as supersededBy", async () => {
			const old = makeEntry({
				topic: "Node.js version",
				content: "Node 16 is LTS",
			});
			await manager.upsert(old);

			const newEntry = makeEntry({
				topic: "Node.js version",
				content: "Node 20 is LTS",
				confidence: 0.95,
			});

			const relation: KnowledgeRelation = {
				type: "supersedes",
				targetId: old.id,
				rationale: "Node 20 is now the LTS version",
				createdAt: Date.now(),
			};

			await manager.saveWithRelation(newEntry, relation);

			// New entry stored with relation
			const stored = await manager.get(newEntry.id);
			expect(stored).not.toBeNull();
			expect(stored?.relations).toHaveLength(1);
			expect(stored?.relations[0]?.type).toBe("supersedes");
			expect(stored?.relations[0]?.targetId).toBe(old.id);

			// Old entry marked as superseded (but still exists)
			const oldStored = await manager.get(old.id);
			expect(oldStored).not.toBeNull();
			expect(oldStored?.supersededBy).toBe(newEntry.id);
		});

		it("stores new entry with refutes relation WITHOUT marking target as superseded", async () => {
			const claim = makeEntry({
				topic: "JavaScript performance",
				content: "eval() is fast for dynamic code execution",
			});
			await manager.upsert(claim);

			const counter = makeEntry({
				topic: "JavaScript performance",
				content: "eval() is slow and unsafe — avoid it",
				confidence: 0.9,
			});

			const relation: KnowledgeRelation = {
				type: "refutes",
				targetId: claim.id,
				rationale: "eval() has significant overhead and security risks",
				createdAt: Date.now(),
			};

			await manager.saveWithRelation(counter, relation);

			// Counter stored with relation
			const stored = await manager.get(counter.id);
			expect(stored?.relations[0]?.type).toBe("refutes");

			// Original NOT marked as superseded
			const claimStored = await manager.get(claim.id);
			expect(claimStored?.supersededBy).toBeUndefined();
		});

		it("preserves original entry's content after saveWithRelation (history preserved)", async () => {
			const original = makeEntry({
				topic: "API versioning",
				content: "Use URL path versioning: /v1/users",
			});
			await manager.upsert(original);

			const updated = makeEntry({
				topic: "API versioning",
				content: "Use header versioning: Accept: application/vnd.api+json;version=2",
				confidence: 0.9,
			});

			const relation: KnowledgeRelation = {
				type: "supersedes",
				targetId: original.id,
				rationale: "Header versioning is more RESTful",
				createdAt: Date.now(),
			};

			await manager.saveWithRelation(updated, relation);

			// Original still readable with original content
			const originalStored = await manager.get(original.id);
			expect(originalStored?.content).toBe("Use URL path versioning: /v1/users");
			expect(originalStored?.supersededBy).toBe(updated.id);
		});

		it("attaches rationale to the stored relation", async () => {
			const old = makeEntry({ topic: "caching strategy", content: "Use Redis" });
			await manager.upsert(old);

			const newer = makeEntry({ topic: "caching strategy", content: "Use Memcached" });
			const relation: KnowledgeRelation = {
				type: "supersedes",
				targetId: old.id,
				rationale: "Memcached is preferred for simple caching",
				createdAt: Date.now(),
			};

			await manager.saveWithRelation(newer, relation);

			const stored = await manager.get(newer.id);
			expect(stored?.relations[0]?.rationale).toBe(
				"Memcached is preferred for simple caching",
			);
		});
	});

	// -----------------------------------------------------------------------
	// getCanonical
	// -----------------------------------------------------------------------

	describe("getCanonical", () => {
		it("returns null when no entries exist for topic", async () => {
			const result = await manager.getCanonical("unknown topic");
			expect(result).toBeNull();
		});

		it("returns single entry as canonical when only one exists", async () => {
			const entry = makeEntry({ topic: "Docker basics", content: "Containers are isolated" });
			await manager.upsert(entry);

			const result = await manager.getCanonical("Docker basics");

			expect(result).not.toBeNull();
			expect(result?.canonical.id).toBe(entry.id);
			expect(result?.history).toHaveLength(0);
		});

		it("returns active (non-superseded) entry as canonical", async () => {
			const old = makeEntry({
				topic: "Node.js LTS",
				content: "Node 16 is LTS",
				confidence: 0.8,
			});
			await manager.upsert(old);

			const current = makeEntry({
				topic: "Node.js LTS",
				content: "Node 20 is LTS",
				confidence: 0.95,
			});
			const relation: KnowledgeRelation = {
				type: "supersedes",
				targetId: old.id,
				rationale: "Node 20 released",
				createdAt: Date.now(),
			};
			await manager.saveWithRelation(current, relation);

			const result = await manager.getCanonical("Node.js LTS");

			expect(result).not.toBeNull();
			expect(result?.canonical.id).toBe(current.id);
			expect(result?.history.map((h) => h.id)).toContain(old.id);
		});

		it("separates canonical from history correctly (supersedes chain)", async () => {
			const v1 = makeEntry({
				topic: "deployment strategy",
				content: "FTP deploy",
				confidence: 0.7,
				createdAt: Date.now() - 2000,
			});
			const v2 = makeEntry({
				topic: "deployment strategy",
				content: "CI/CD pipeline",
				confidence: 0.9,
				createdAt: Date.now() - 1000,
			});
			await manager.upsert(v1);
			await manager.saveWithRelation(v2, {
				type: "supersedes",
				targetId: v1.id,
				rationale: "Modern approach",
				createdAt: Date.now() - 1000,
			});

			const result = await manager.getCanonical("deployment strategy");

			expect(result?.canonical.id).toBe(v2.id);
			expect(result?.history).toHaveLength(1);
			expect(result?.history[0]?.id).toBe(v1.id);
		});

		it("picks highest-confidence active entry when multiple active entries exist", async () => {
			const lowConf = makeEntry({
				topic: "sorting algorithms",
				content: "Bubble sort is simple",
				confidence: 0.6,
			});
			const highConf = makeEntry({
				topic: "sorting algorithms",
				content: "QuickSort is efficient for most cases",
				confidence: 0.95,
			});

			await manager.upsert(lowConf);
			await manager.upsert(highConf);

			const result = await manager.getCanonical("sorting algorithms");

			expect(result?.canonical.id).toBe(highConf.id);
			expect(result?.history.map((h) => h.id)).toContain(lowConf.id);
		});

		it("returns both active entries when refutes relation (neither superseded)", async () => {
			const claim = makeEntry({
				topic: "tabs vs spaces",
				content: "Use tabs for indentation",
				confidence: 0.7,
			});
			const counter = makeEntry({
				topic: "tabs vs spaces",
				content: "Use spaces for indentation",
				confidence: 0.85,
			});
			await manager.upsert(claim);
			await manager.saveWithRelation(counter, {
				type: "refutes",
				targetId: claim.id,
				rationale: "Style guide preference",
				createdAt: Date.now(),
			});

			const result = await manager.getCanonical("tabs vs spaces");

			// counter has higher confidence → canonical
			expect(result?.canonical.id).toBe(counter.id);
			// claim is still active (not superseded) → in history
			expect(result?.history.map((h) => h.id)).toContain(claim.id);
		});
	});

	// -----------------------------------------------------------------------
	// upsertWithConflictDetection
	// -----------------------------------------------------------------------

	describe("upsertWithConflictDetection", () => {
		it("stores entry normally when no conflicts exist", async () => {
			const entry = makeEntry({
				topic: "unique topic abc",
				content: "some content",
			});

			const result = await manager.upsertWithConflictDetection(entry);

			expect(result.conflictsFound).toBe(0);
			const stored = await manager.get(entry.id);
			expect(stored).not.toBeNull();
		});

		it("detects and links conflicting entries automatically", async () => {
			const existing = makeEntry({
				topic: "memory management",
				content: "Manual memory allocation with malloc and free",
			});
			await manager.upsert(existing);

			const newEntry = makeEntry({
				topic: "memory management",
				content: "Automatic memory management with garbage collection",
			});

			const result = await manager.upsertWithConflictDetection(newEntry);

			expect(result.conflictsFound).toBeGreaterThan(0);

			const stored = await manager.get(newEntry.id);
			expect(stored?.relations.length).toBeGreaterThan(0);
		});

		it("returns conflictsFound count matching actual conflicts", async () => {
			const e1 = makeEntry({ topic: "logging", content: "Use console.log for debugging" });
			const e2 = makeEntry({ topic: "logging", content: "Use a logger library" });
			await manager.upsert(e1);
			await manager.upsert(e2);

			const newEntry = makeEntry({
				topic: "logging",
				content: "Structured logging with JSON output is preferred",
			});

			const result = await manager.upsertWithConflictDetection(newEntry);

			expect(result.conflictsFound).toBe(2);
		});

		it("existing entry is marked supersededBy when new entry supersedes it", async () => {
			const old = makeEntry({
				topic: "CSS framework",
				content: "Use Bootstrap for responsive design and rapid prototyping",
			});
			await manager.upsert(old);

			const updated = makeEntry({
				topic: "CSS framework",
				content: "Use Tailwind CSS for responsive design and rapid prototyping with utilities",
				confidence: 0.95,
			});

			await manager.upsertWithConflictDetection(updated);

			// Check if old is marked superseded
			const oldStored = await manager.get(old.id);
			// The auto-detection should have superseded the similar entry
			expect(oldStored?.supersededBy).toBe(updated.id);
		});
	});

	// -----------------------------------------------------------------------
	// search exclusion of superseded entries
	// -----------------------------------------------------------------------

	describe("search excludes superseded entries", () => {
		it("excludes superseded entry from search results", async () => {
			const old = makeEntry({
				topic: "async patterns",
				content: "Use callbacks for async operations",
				strength: 0.8,
				confidence: 0.8,
			});
			await manager.upsert(old);

			const current = makeEntry({
				topic: "async patterns",
				content: "Use Promises or async/await for async operations",
				strength: 0.8,
				confidence: 0.95,
			});
			await manager.saveWithRelation(current, {
				type: "supersedes",
				targetId: old.id,
				rationale: "Modern async patterns",
				createdAt: Date.now(),
			});

			const results = await manager.search("async patterns");
			const ids = results.map((r) => r.id);

			expect(ids).toContain(current.id);
			expect(ids).not.toContain(old.id);
		});

		it("includes refuted entries in search results (both active)", async () => {
			const claim = makeEntry({
				topic: "test strategy",
				content: "Unit tests are sufficient for quality assurance",
				strength: 0.8,
				confidence: 0.7,
			});
			const counter = makeEntry({
				topic: "test strategy",
				content: "Integration tests are necessary in addition to unit tests",
				strength: 0.8,
				confidence: 0.85,
			});
			await manager.upsert(claim);
			await manager.saveWithRelation(counter, {
				type: "refutes",
				targetId: claim.id,
				rationale: "Need multiple test layers",
				createdAt: Date.now(),
			});

			const results = await manager.search("test strategy");
			const ids = results.map((r) => r.id);

			// Both should appear since neither was superseded
			expect(ids).toContain(claim.id);
			expect(ids).toContain(counter.id);
		});
	});

	// -----------------------------------------------------------------------
	// Regression: conflicting info preserves original history
	// -----------------------------------------------------------------------

	describe("history preservation", () => {
		it("superseded entry is NOT deleted — retrievable by ID", async () => {
			const original = makeEntry({
				topic: "HTTP methods",
				content: "GET for reading, POST for creating",
			});
			await manager.upsert(original);

			const updated = makeEntry({
				topic: "HTTP methods",
				content: "GET, POST, PUT, PATCH, DELETE — full REST verbs",
				confidence: 0.95,
			});
			await manager.saveWithRelation(updated, {
				type: "supersedes",
				targetId: original.id,
				rationale: "More complete description",
				createdAt: Date.now(),
			});

			// Original must still be retrievable
			const originalStored = await manager.get(original.id);
			expect(originalStored).not.toBeNull();
			expect(originalStored?.content).toBe("GET for reading, POST for creating");
		});

		it("supersedes chain is navigable via relations", async () => {
			const v1 = makeEntry({ topic: "auth strategy", content: "Basic auth", confidence: 0.6 });
			const v2 = makeEntry({ topic: "auth strategy", content: "JWT auth", confidence: 0.8 });
			const v3 = makeEntry({ topic: "auth strategy", content: "OAuth2 with PKCE", confidence: 0.95 });

			await manager.upsert(v1);
			await manager.saveWithRelation(v2, {
				type: "supersedes",
				targetId: v1.id,
				rationale: "JWT more scalable",
				createdAt: Date.now() - 1000,
			});
			await manager.saveWithRelation(v3, {
				type: "supersedes",
				targetId: v2.id,
				rationale: "OAuth2 is more secure",
				createdAt: Date.now(),
			});

			// v3 is canonical
			const canonical = await manager.getCanonical("auth strategy");
			expect(canonical?.canonical.id).toBe(v3.id);

			// v1 and v2 are in history
			const historyIds = canonical?.history.map((h) => h.id) ?? [];
			expect(historyIds).toContain(v1.id);
			expect(historyIds).toContain(v2.id);

			// v2 has relation to v1
			const v2Stored = await manager.get(v2.id);
			expect(v2Stored?.relations.some((r) => r.targetId === v1.id)).toBe(true);

			// v3 has relation to v2
			const v3Stored = await manager.get(v3.id);
			expect(v3Stored?.relations.some((r) => r.targetId === v2.id)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// KnowledgeEntry schema — backward compatibility with new relation fields
	// -----------------------------------------------------------------------

	describe("backward compatibility with relation fields", () => {
		it("reads entries without relations field and defaults to empty array", async () => {
			const { writeFile } = await import("node:fs/promises");
			const { join: pathJoin } = await import("node:path");

			const id = randomUUID();
			const oldEntry = {
				id,
				topic: "legacy topic",
				content: "legacy content",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: [],
				strength: 1.0,
				lastReferencedAt: Date.now(),
				referenceCount: 0,
				tier: "scratchpad",
				tierCreatedAt: Date.now(),
				promotionScore: 0,
				// No relations or supersededBy fields
			};
			const safeName = id.replace(/[^a-zA-Z0-9_-]/g, "_");
			await writeFile(
				pathJoin(memoryDir, `${safeName}.json`),
				JSON.stringify(oldEntry, null, 2),
				"utf8",
			);

			const read = await manager.get(id);
			expect(read).not.toBeNull();
			expect(read?.relations).toEqual([]);
			expect(read?.supersededBy).toBeUndefined();
		});
	});
});
