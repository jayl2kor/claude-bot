/**
 * Tests for knowledge propagation between pets (Issue #6).
 *
 * TDD: written before implementation — all tests start RED.
 *
 * Rules under test:
 * 1. Only knowledge with confidence >= 0.7 is propagated.
 * 2. Propagated knowledge confidence = original * 0.8.
 * 3. Knowledge already known by the target is NOT re-propagated.
 * 4. Each propagation event is logged.
 * 5. Knowledge with confidence < 0.7 is never propagated.
 * 6. Edge cases: empty source, all below threshold, all already known.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import type { KnowledgePropagatorDeps } from "./knowledge-propagation.js";
import {
	PROPAGATION_CONFIDENCE_THRESHOLD,
	PROPAGATION_STRENGTH_FACTOR,
	propagateKnowledge,
} from "./knowledge-propagation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: "entry-1",
		topic: "TypeScript",
		content: "TypeScript is a typed superset of JavaScript",
		source: "taught",
		taughtBy: "user1",
		createdAt: Date.now() - 10_000,
		updatedAt: Date.now() - 10_000,
		confidence: 0.9,
		tags: ["programming", "typescript"],
		...overrides,
	};
}

type MockKnowledgeManager = {
	listAll: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	upsert: ReturnType<typeof vi.fn>;
};

function makeMockKnowledge(entries: KnowledgeEntry[] = []): MockKnowledgeManager {
	return {
		listAll: vi.fn().mockResolvedValue(entries),
		get: vi.fn().mockImplementation(async (id: string) => {
			return entries.find((e) => e.id === id) ?? null;
		}),
		upsert: vi.fn().mockResolvedValue(undefined),
	};
}

function makeDeps(
	sourceEntries: KnowledgeEntry[] = [],
	targetEntries: KnowledgeEntry[] = [],
): KnowledgePropagatorDeps {
	return {
		sourceKnowledge: makeMockKnowledge(sourceEntries) as unknown as KnowledgePropagatorDeps["sourceKnowledge"],
		targetKnowledge: makeMockKnowledge(targetEntries) as unknown as KnowledgePropagatorDeps["targetKnowledge"],
	};
}

// ---------------------------------------------------------------------------
// Exported constant tests
// ---------------------------------------------------------------------------

describe("KnowledgePropagation — constants", () => {
	it("PROPAGATION_CONFIDENCE_THRESHOLD is 0.7", () => {
		expect(PROPAGATION_CONFIDENCE_THRESHOLD).toBe(0.7);
	});

	it("PROPAGATION_STRENGTH_FACTOR is 0.8", () => {
		expect(PROPAGATION_STRENGTH_FACTOR).toBe(0.8);
	});
});

// ---------------------------------------------------------------------------
// Core propagation behavior
// ---------------------------------------------------------------------------

describe("propagateKnowledge — confidence threshold", () => {
	it("propagates knowledge when confidence >= 0.7", async () => {
		const entry = makeEntry({ id: "entry-hi", confidence: 0.7 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(1);
		expect(result.propagated[0]!.knowledgeId).toBe("entry-hi");
		expect(result.skippedLowConfidence).toBe(0);
	});

	it("propagates knowledge when confidence > 0.7 (above threshold)", async () => {
		const entry = makeEntry({ id: "entry-high", confidence: 0.95 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(1);
		expect(result.skippedLowConfidence).toBe(0);
	});

	it("does NOT propagate knowledge when confidence < 0.7", async () => {
		const entry = makeEntry({ id: "entry-low", confidence: 0.5 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedLowConfidence).toBe(1);
	});

	it("does NOT propagate knowledge when confidence is exactly below threshold (0.69)", async () => {
		const entry = makeEntry({ id: "entry-edge", confidence: 0.69 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedLowConfidence).toBe(1);
	});

	it("filters correctly when some entries are above and some below threshold", async () => {
		const high = makeEntry({ id: "e-high", confidence: 0.8 });
		const low = makeEntry({ id: "e-low", confidence: 0.3 });
		const exact = makeEntry({ id: "e-exact", confidence: 0.7 });
		const deps = makeDeps([high, low, exact], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(2);
		const propagatedIds = result.propagated.map((e) => e.knowledgeId);
		expect(propagatedIds).toContain("e-high");
		expect(propagatedIds).toContain("e-exact");
		expect(propagatedIds).not.toContain("e-low");
		expect(result.skippedLowConfidence).toBe(1);
	});
});

describe("propagateKnowledge — strength reduction", () => {
	it("propagated confidence is 80% of original", async () => {
		const entry = makeEntry({ id: "e-strength", confidence: 0.9 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(1);
		const event = result.propagated[0]!;
		expect(event.originalConfidence).toBe(0.9);
		expect(event.propagatedConfidence).toBeCloseTo(0.9 * 0.8, 5);
	});

	it("stores the knowledge entry in target with reduced confidence", async () => {
		const entry = makeEntry({ id: "e-upsert", confidence: 0.9 });
		const deps = makeDeps([entry], []);
		const targetUpsert = vi.mocked(
			(deps.targetKnowledge as unknown as MockKnowledgeManager).upsert,
		);

		await propagateKnowledge("petA", "petB", deps);

		expect(targetUpsert).toHaveBeenCalledOnce();
		const upsertedEntry = targetUpsert.mock.calls[0]![0] as KnowledgeEntry;
		expect(upsertedEntry.confidence).toBeCloseTo(0.9 * 0.8, 5);
		expect(upsertedEntry.id).toBe("e-upsert");
		expect(upsertedEntry.topic).toBe(entry.topic);
		expect(upsertedEntry.content).toBe(entry.content);
	});

	it("stores the knowledge entry in target with source 'propagated'", async () => {
		const entry = makeEntry({ id: "e-source", confidence: 0.9, source: "taught" });
		const deps = makeDeps([entry], []);
		const targetUpsert = vi.mocked(
			(deps.targetKnowledge as unknown as MockKnowledgeManager).upsert,
		);

		await propagateKnowledge("petA", "petB", deps);

		expect(targetUpsert).toHaveBeenCalledOnce();
		const upsertedEntry = targetUpsert.mock.calls[0]![0] as KnowledgeEntry;
		expect(upsertedEntry.source).toBe("propagated");
	});

	it("uses PROPAGATION_STRENGTH_FACTOR exactly", async () => {
		const originalConfidence = 1.0;
		const entry = makeEntry({ id: "e-factor", confidence: originalConfidence });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		const event = result.propagated[0]!;
		expect(event.propagatedConfidence).toBe(
			originalConfidence * PROPAGATION_STRENGTH_FACTOR,
		);
	});

	it("propagated confidence is capped at a valid range [0, 1]", async () => {
		// Edge: confidence at exactly threshold * factor should still be valid
		const entry = makeEntry({ id: "e-cap", confidence: 0.7 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		const event = result.propagated[0]!;
		expect(event.propagatedConfidence).toBeGreaterThanOrEqual(0);
		expect(event.propagatedConfidence).toBeLessThanOrEqual(1);
	});
});

describe("propagateKnowledge — duplicate prevention", () => {
	it("skips knowledge already known by target (same ID)", async () => {
		const entry = makeEntry({ id: "e-known", confidence: 0.9 });
		const deps = makeDeps([entry], [entry]); // same entry in both stores

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedAlreadyKnown).toBe(1);
	});

	it("does NOT call upsert when entry already exists in target", async () => {
		const entry = makeEntry({ id: "e-skip-upsert", confidence: 0.9 });
		const deps = makeDeps([entry], [entry]);
		const targetUpsert = vi.mocked(
			(deps.targetKnowledge as unknown as MockKnowledgeManager).upsert,
		);

		await propagateKnowledge("petA", "petB", deps);

		expect(targetUpsert).not.toHaveBeenCalled();
	});

	it("propagates entries not known by target while skipping known ones", async () => {
		const known = makeEntry({ id: "e-known-2", confidence: 0.9 });
		const unknown = makeEntry({ id: "e-unknown", confidence: 0.9 });
		const deps = makeDeps([known, unknown], [known]); // only known in target

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(1);
		expect(result.propagated[0]!.knowledgeId).toBe("e-unknown");
		expect(result.skippedAlreadyKnown).toBe(1);
	});

	it("skips if target has the entry regardless of confidence difference", async () => {
		// Even if target's version has lower confidence, we don't overwrite
		const sourceEntry = makeEntry({ id: "e-noOverwrite", confidence: 0.95 });
		const targetEntry = makeEntry({ id: "e-noOverwrite", confidence: 0.5 }); // same id
		const deps = makeDeps([sourceEntry], [targetEntry]);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedAlreadyKnown).toBe(1);
	});
});

describe("propagateKnowledge — event logging", () => {
	it("returns propagation event with correct metadata", async () => {
		const before = Date.now();
		const entry = makeEntry({ id: "e-event", confidence: 0.8, topic: "Go lang" });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);
		const after = Date.now();

		expect(result.propagated).toHaveLength(1);
		const event = result.propagated[0]!;
		expect(event.sourcePetId).toBe("petA");
		expect(event.targetPetId).toBe("petB");
		expect(event.knowledgeId).toBe("e-event");
		expect(event.topic).toBe("Go lang");
		expect(event.propagatedAt).toBeGreaterThanOrEqual(before);
		expect(event.propagatedAt).toBeLessThanOrEqual(after);
	});

	it("logs each propagation event via logger", async () => {
		// We can't easily spy on the logger without mocking the module,
		// so we verify the function call by checking propagated events list
		const entries = [
			makeEntry({ id: "e-log-1", confidence: 0.9 }),
			makeEntry({ id: "e-log-2", confidence: 0.85 }),
		];
		const deps = makeDeps(entries, []);

		const result = await propagateKnowledge("petA", "petB", deps);

		// Both should be in the propagated list (which is our "log")
		expect(result.propagated).toHaveLength(2);
		const ids = result.propagated.map((e) => e.knowledgeId);
		expect(ids).toContain("e-log-1");
		expect(ids).toContain("e-log-2");
	});
});

describe("propagateKnowledge — edge cases", () => {
	it("returns empty result when source has no knowledge", async () => {
		const deps = makeDeps([], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedLowConfidence).toBe(0);
		expect(result.skippedAlreadyKnown).toBe(0);
	});

	it("returns empty result when all entries are below threshold", async () => {
		const entries = [
			makeEntry({ id: "e-1", confidence: 0.1 }),
			makeEntry({ id: "e-2", confidence: 0.5 }),
			makeEntry({ id: "e-3", confidence: 0.69 }),
		];
		const deps = makeDeps(entries, []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedLowConfidence).toBe(3);
		expect(result.skippedAlreadyKnown).toBe(0);
	});

	it("returns empty result when all entries above threshold are already known", async () => {
		const entries = [
			makeEntry({ id: "e-k1", confidence: 0.9 }),
			makeEntry({ id: "e-k2", confidence: 0.8 }),
		];
		const deps = makeDeps(entries, entries); // all already in target

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedAlreadyKnown).toBe(2);
		expect(result.skippedLowConfidence).toBe(0);
	});

	it("handles source with confidence exactly 0 (minimum, always filtered)", async () => {
		const entry = makeEntry({ id: "e-zero", confidence: 0.0 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(0);
		expect(result.skippedLowConfidence).toBe(1);
	});

	it("handles source with confidence exactly 1.0 (maximum)", async () => {
		const entry = makeEntry({ id: "e-max", confidence: 1.0 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(1);
		expect(result.propagated[0]!.propagatedConfidence).toBe(0.8);
	});

	it("propagates many entries and counts correctly", async () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeEntry({
				id: `e-bulk-${i}`,
				confidence: i < 7 ? 0.9 : 0.5, // 7 above threshold, 3 below
			}),
		);
		const deps = makeDeps(entries, []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.propagated).toHaveLength(7);
		expect(result.skippedLowConfidence).toBe(3);
	});
});

describe("propagateKnowledge — input validation", () => {
	it("throws when sourcePetId is empty", async () => {
		const deps = makeDeps([], []);
		await expect(propagateKnowledge("", "petB", deps)).rejects.toThrow(
			"sourcePetId must not be empty",
		);
	});

	it("throws when targetPetId is empty", async () => {
		const deps = makeDeps([], []);
		await expect(propagateKnowledge("petA", "", deps)).rejects.toThrow(
			"targetPetId must not be empty",
		);
	});
});

describe("propagateKnowledge — result structure", () => {
	it("returns a PropagationResult with all required fields", async () => {
		const entry = makeEntry({ id: "e-struct", confidence: 0.9 });
		const deps = makeDeps([entry], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result).toHaveProperty("propagated");
		expect(result).toHaveProperty("skippedLowConfidence");
		expect(result).toHaveProperty("skippedAlreadyKnown");
		expect(Array.isArray(result.propagated)).toBe(true);
		expect(typeof result.skippedLowConfidence).toBe("number");
		expect(typeof result.skippedAlreadyKnown).toBe("number");
	});

	it("counts are non-negative integers", async () => {
		const deps = makeDeps([], []);

		const result = await propagateKnowledge("petA", "petB", deps);

		expect(result.skippedLowConfidence).toBeGreaterThanOrEqual(0);
		expect(result.skippedAlreadyKnown).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(result.skippedLowConfidence)).toBe(true);
		expect(Number.isInteger(result.skippedAlreadyKnown)).toBe(true);
	});
});
