/**
 * Tests for decay differentiation — covers:
 * - Multiplier calculation for expert domain knowledge
 * - Non-expert domain returns 1.0 (no change)
 * - Tag-based domain matching
 * - Edge cases (empty domains, empty tags)
 */

import { describe, expect, it } from "vitest";
import { getDecayMultiplier } from "./decay.js";

describe("getDecayMultiplier", () => {
	it("returns multiplier for knowledge matching expert domain", () => {
		const result = getDecayMultiplier(
			{ tags: ["docker", "devops"], topic: "Docker basics" },
			["docker", "devops"],
			0.3,
		);
		expect(result).toBe(0.3);
	});

	it("returns 1.0 for knowledge not matching any expert domain", () => {
		const result = getDecayMultiplier(
			{ tags: ["react", "frontend"], topic: "React hooks" },
			["docker", "devops"],
			0.3,
		);
		expect(result).toBe(1.0);
	});

	it("matches domain against topic (case-insensitive)", () => {
		const result = getDecayMultiplier(
			{ tags: [], topic: "Docker Compose patterns" },
			["docker"],
			0.3,
		);
		expect(result).toBe(0.3);
	});

	it("matches domain against tags (case-insensitive)", () => {
		const result = getDecayMultiplier(
			{ tags: ["Docker"], topic: "Container stuff" },
			["docker"],
			0.3,
		);
		expect(result).toBe(0.3);
	});

	it("returns 1.0 when expertiseDomains is empty", () => {
		const result = getDecayMultiplier(
			{ tags: ["docker"], topic: "Docker" },
			[],
			0.3,
		);
		expect(result).toBe(1.0);
	});

	it("returns 1.0 when entry has no tags and topic does not match", () => {
		const result = getDecayMultiplier(
			{ tags: [], topic: "Random topic" },
			["docker"],
			0.3,
		);
		expect(result).toBe(1.0);
	});

	it("uses the provided multiplier value", () => {
		const result = getDecayMultiplier(
			{ tags: ["docker"], topic: "Docker" },
			["docker"],
			0.5,
		);
		expect(result).toBe(0.5);
	});

	it("handles partial word matching in topic", () => {
		// "docker" domain should match "docker-compose" topic
		const result = getDecayMultiplier(
			{ tags: [], topic: "docker-compose setup" },
			["docker"],
			0.3,
		);
		expect(result).toBe(0.3);
	});

	it("handles seeded tag without matching domain", () => {
		const result = getDecayMultiplier(
			{ tags: ["seeded", "cooking"], topic: "Recipe" },
			["docker"],
			0.3,
		);
		expect(result).toBe(1.0);
	});
});
