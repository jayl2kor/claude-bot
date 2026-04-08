/**
 * Tests for expertise type schemas — covers:
 * - ExpertiseConfigSchema validation, defaults
 * - SeedKnowledgeEntrySchema validation
 * - SeedStateSchema validation
 */

import { describe, expect, it } from "vitest";
import {
	ExpertiseConfigSchema,
	SeedKnowledgeEntrySchema,
	SeedStateSchema,
} from "./types.js";

// ---------------------------------------------------------------------------
// ExpertiseConfigSchema
// ---------------------------------------------------------------------------

describe("ExpertiseConfigSchema", () => {
	it("parses empty object with all defaults", () => {
		const result = ExpertiseConfigSchema.parse({});
		expect(result.domains).toEqual([]);
		expect(result.decayMultiplier).toBe(0.3);
		expect(result.deferTo).toEqual({});
	});

	it("accepts custom domains", () => {
		const result = ExpertiseConfigSchema.parse({
			domains: ["backend", "devops", "docker"],
		});
		expect(result.domains).toEqual(["backend", "devops", "docker"]);
	});

	it("accepts custom decayMultiplier", () => {
		const result = ExpertiseConfigSchema.parse({ decayMultiplier: 0.5 });
		expect(result.decayMultiplier).toBe(0.5);
	});

	it("accepts deferTo mapping", () => {
		const result = ExpertiseConfigSchema.parse({
			deferTo: { frontend: "reboong", backend: "coboonge" },
		});
		expect(result.deferTo).toEqual({
			frontend: "reboong",
			backend: "coboonge",
		});
	});

	it("rejects decayMultiplier below 0", () => {
		expect(() =>
			ExpertiseConfigSchema.parse({ decayMultiplier: -0.1 }),
		).toThrow();
	});

	it("rejects decayMultiplier above 1", () => {
		expect(() =>
			ExpertiseConfigSchema.parse({ decayMultiplier: 1.5 }),
		).toThrow();
	});

	it("accepts full config", () => {
		const result = ExpertiseConfigSchema.parse({
			domains: ["backend"],
			decayMultiplier: 0.2,
			deferTo: { frontend: "reboong" },
		});
		expect(result.domains).toEqual(["backend"]);
		expect(result.decayMultiplier).toBe(0.2);
		expect(result.deferTo).toEqual({ frontend: "reboong" });
	});
});

// ---------------------------------------------------------------------------
// SeedKnowledgeEntrySchema
// ---------------------------------------------------------------------------

describe("SeedKnowledgeEntrySchema", () => {
	it("validates a complete entry", () => {
		const result = SeedKnowledgeEntrySchema.parse({
			topic: "Docker basics",
			content: "Docker uses containers for isolation",
			tags: ["docker", "devops"],
			confidence: 0.9,
		});
		expect(result.topic).toBe("Docker basics");
		expect(result.content).toBe("Docker uses containers for isolation");
		expect(result.tags).toEqual(["docker", "devops"]);
		expect(result.confidence).toBe(0.9);
	});

	it("applies default confidence", () => {
		const result = SeedKnowledgeEntrySchema.parse({
			topic: "Test",
			content: "Content",
			tags: [],
		});
		expect(result.confidence).toBe(0.8);
	});

	it("applies default tags", () => {
		const result = SeedKnowledgeEntrySchema.parse({
			topic: "Test",
			content: "Content",
		});
		expect(result.tags).toEqual([]);
	});

	it("rejects missing topic", () => {
		expect(() =>
			SeedKnowledgeEntrySchema.parse({ content: "C", tags: [] }),
		).toThrow();
	});

	it("rejects missing content", () => {
		expect(() =>
			SeedKnowledgeEntrySchema.parse({ topic: "T", tags: [] }),
		).toThrow();
	});

	it("rejects confidence below 0", () => {
		expect(() =>
			SeedKnowledgeEntrySchema.parse({
				topic: "T",
				content: "C",
				tags: [],
				confidence: -0.1,
			}),
		).toThrow();
	});

	it("rejects confidence above 1", () => {
		expect(() =>
			SeedKnowledgeEntrySchema.parse({
				topic: "T",
				content: "C",
				tags: [],
				confidence: 1.5,
			}),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// SeedStateSchema
// ---------------------------------------------------------------------------

describe("SeedStateSchema", () => {
	it("parses valid state", () => {
		const result = SeedStateSchema.parse({
			importedHashes: ["abc123", "def456"],
		});
		expect(result.importedHashes).toEqual(["abc123", "def456"]);
	});

	it("defaults to empty array", () => {
		const result = SeedStateSchema.parse({});
		expect(result.importedHashes).toEqual([]);
	});

	it("accepts empty array", () => {
		const result = SeedStateSchema.parse({ importedHashes: [] });
		expect(result.importedHashes).toEqual([]);
	});
});
