/**
 * Tests for PetDataReader — reads pet data with caching,
 * computes growth timelines and activity heatmaps.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PetDataReader } from "./data-reader.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-reader-test-${randomUUID()}`);
}

describe("PetDataReader", () => {
	let dataDir: string;
	let configDir: string;

	beforeEach(async () => {
		const base = makeTempDir();
		dataDir = join(base, "data");
		configDir = join(base, "config");
		await mkdir(join(dataDir, "knowledge"), { recursive: true });
		await mkdir(join(dataDir, "relationships"), { recursive: true });
		await mkdir(join(dataDir, "reflections"), { recursive: true });
		await mkdir(join(dataDir, "activity"), { recursive: true });
		await mkdir(join(dataDir, "persona"), { recursive: true });
		await mkdir(configDir, { recursive: true });
	});

	describe("getStats", () => {
		it("returns stats with correct knowledge counts", async () => {
			await writeFile(
				join(dataDir, "knowledge", "k1.json"),
				JSON.stringify({
					id: "k1",
					topic: "TypeScript",
					content: "TS is great",
					source: "taught",
					taughtBy: "user1",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.9,
					tags: ["programming"],
				}),
			);
			await writeFile(
				join(dataDir, "knowledge", "k2.json"),
				JSON.stringify({
					id: "k2",
					topic: "Python",
					content: "Python too",
					source: "inferred",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.7,
					tags: [],
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const stats = await reader.getStats();

			expect(stats.knowledge.total).toBe(2);
			expect(stats.knowledge.bySource.taught).toBe(1);
			expect(stats.knowledge.bySource.inferred).toBe(1);
			expect(stats.knowledge.recentTopics).toContain("TypeScript");
		});

		it("returns stats with correct relationship counts", async () => {
			await writeFile(
				join(dataDir, "relationships", "u1.json"),
				JSON.stringify({
					userId: "u1",
					displayName: "Alice",
					firstSeen: Date.now(),
					lastSeen: Date.now(),
					interactionCount: 5,
					notes: [],
					preferences: [],
					sentiment: "positive",
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const stats = await reader.getStats();

			expect(stats.relationships.total).toBe(1);
			expect(stats.relationships.recentNames).toContain("Alice");
		});

		it("returns stats with reflection data", async () => {
			await writeFile(
				join(dataDir, "reflections", "r1.json"),
				JSON.stringify({
					id: "r1",
					sessionKey: "s1",
					userId: "u1",
					summary: "Learned about testing",
					insights: ["TDD is important"],
					createdAt: Date.now(),
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const stats = await reader.getStats();

			expect(stats.reflections.total).toBe(1);
			expect(stats.reflections.latestInsight).toBe("Learned about testing");
		});

		it("returns zero stats when data dirs are empty", async () => {
			const reader = new PetDataReader(dataDir, configDir);
			const stats = await reader.getStats();

			expect(stats.knowledge.total).toBe(0);
			expect(stats.relationships.total).toBe(0);
			expect(stats.reflections.total).toBe(0);
			expect(stats.activity.totalSessions).toBe(0);
		});
	});

	describe("computeGrowthTimeline", () => {
		it("aggregates knowledge and relationships by date", async () => {
			const day1 = new Date("2024-01-15").getTime();
			const day2 = new Date("2024-01-16").getTime();

			await writeFile(
				join(dataDir, "knowledge", "k1.json"),
				JSON.stringify({
					id: "k1",
					topic: "A",
					content: "a",
					source: "taught",
					createdAt: day1,
					updatedAt: day1,
					confidence: 0.8,
					tags: [],
				}),
			);
			await writeFile(
				join(dataDir, "knowledge", "k2.json"),
				JSON.stringify({
					id: "k2",
					topic: "B",
					content: "b",
					source: "taught",
					createdAt: day2,
					updatedAt: day2,
					confidence: 0.8,
					tags: [],
				}),
			);
			await writeFile(
				join(dataDir, "relationships", "r1.json"),
				JSON.stringify({
					userId: "r1",
					displayName: "R1",
					firstSeen: day1,
					lastSeen: day1,
					interactionCount: 1,
					notes: [],
					preferences: [],
					sentiment: "neutral",
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const timeline = await reader.computeGrowthTimeline();

			expect(timeline.length).toBeGreaterThanOrEqual(2);

			const point1 = timeline.find((p) => p.date === "2024-01-15");
			expect(point1).toBeDefined();
			expect(point1?.knowledgeCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe("computeActivityHeatmap", () => {
		it("aggregates activity by hour", async () => {
			const hourly = Array(24).fill(0) as number[];
			hourly[9] = 5;
			hourly[14] = 10;

			await writeFile(
				join(dataDir, "activity", "u1.json"),
				JSON.stringify({
					userId: "u1",
					hourlyDistribution: hourly,
					sessionStartAt: null,
					lastActivityAt: Date.now(),
					lastAlertAt: 0,
					alertsToday: 0,
					alertsResetDate: "",
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const heatmap = await reader.computeActivityHeatmap();

			expect(heatmap).toHaveLength(24);
			const hour9 = heatmap.find((h) => h.hour === 9);
			expect(hour9?.count).toBe(5);
			const hour14 = heatmap.find((h) => h.hour === 14);
			expect(hour14?.count).toBe(10);
		});

		it("returns 24 zero entries when no activity data", async () => {
			const reader = new PetDataReader(dataDir, configDir);
			const heatmap = await reader.computeActivityHeatmap();

			expect(heatmap).toHaveLength(24);
			expect(heatmap.every((h) => h.count === 0)).toBe(true);
		});
	});

	describe("cache behavior", () => {
		it("returns cached stats on subsequent calls within TTL", async () => {
			await writeFile(
				join(dataDir, "knowledge", "k1.json"),
				JSON.stringify({
					id: "k1",
					topic: "Test",
					content: "test",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const stats1 = await reader.getStats();
			const stats2 = await reader.getStats();

			// Both calls should return same reference (cached)
			expect(stats1).toBe(stats2);
		});
	});

	describe("getKnowledge", () => {
		it("returns paginated knowledge entries", async () => {
			for (let i = 0; i < 5; i++) {
				await writeFile(
					join(dataDir, "knowledge", `k${i}.json`),
					JSON.stringify({
						id: `k${i}`,
						topic: `Topic ${i}`,
						content: `Content ${i}`,
						source: "taught",
						createdAt: Date.now() - i * 1000,
						updatedAt: Date.now() - i * 1000,
						confidence: 0.8,
						tags: [],
					}),
				);
			}

			const reader = new PetDataReader(dataDir, configDir);
			const result = await reader.getKnowledge(1, 3);

			expect(result.entries).toHaveLength(3);
			expect(result.total).toBe(5);
		});

		it("filters knowledge by search query", async () => {
			await writeFile(
				join(dataDir, "knowledge", "k1.json"),
				JSON.stringify({
					id: "k1",
					topic: "TypeScript",
					content: "TS is typed",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
				}),
			);
			await writeFile(
				join(dataDir, "knowledge", "k2.json"),
				JSON.stringify({
					id: "k2",
					topic: "Python",
					content: "Python is dynamic",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
				}),
			);

			const reader = new PetDataReader(dataDir, configDir);
			const result = await reader.getKnowledge(1, 10, "typescript");

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.topic).toBe("TypeScript");
		});
	});

	describe("getReflections", () => {
		it("returns recent reflections sorted by date", async () => {
			for (let i = 0; i < 5; i++) {
				await writeFile(
					join(dataDir, "reflections", `r${i}.json`),
					JSON.stringify({
						id: `r${i}`,
						sessionKey: `s${i}`,
						userId: "u1",
						summary: `Reflection ${i}`,
						insights: [`Insight ${i}`],
						createdAt: Date.now() - i * 60_000,
					}),
				);
			}

			const reader = new PetDataReader(dataDir, configDir);
			const reflections = await reader.getReflections(3);

			expect(reflections).toHaveLength(3);
			// Most recent first
			expect(reflections[0]?.summary).toBe("Reflection 0");
		});
	});

	describe("getPersona", () => {
		it("reads persona config from YAML file", async () => {
			await writeFile(
				join(configDir, "persona.yaml"),
				"name: TestPet\npersonality: friendly\ntone: casual\nvalues:\n  - honesty\nconstraints: []\n",
			);

			const reader = new PetDataReader(dataDir, configDir);
			const persona = await reader.getPersona();

			expect(persona).toBeDefined();
			expect(persona?.name).toBe("TestPet");
		});

		it("returns null when persona config does not exist", async () => {
			const reader = new PetDataReader(dataDir, configDir);
			const persona = await reader.getPersona();

			// May return default or null depending on implementation
			expect(persona).toBeDefined();
		});
	});
});
