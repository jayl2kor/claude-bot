/**
 * Tests for PetDiscovery — scans shared-status and data dirs
 * to discover pets and determine online/offline status.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PetDiscovery } from "./pet-discovery.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-discovery-test-${randomUUID()}`);
}

function makeStatusFile(petId: string, heartbeatAt: number): string {
	return JSON.stringify({
		petId,
		personaName: petId,
		activeSessionCount: 1,
		sessions: [],
		heartbeatAt,
		startedAt: heartbeatAt - 60_000,
	});
}

describe("PetDiscovery", () => {
	let statusDir: string;
	let dataDir1: string;
	let dataDir2: string;
	let configDir1: string;
	let configDir2: string;

	beforeEach(async () => {
		const base = makeTempDir();
		statusDir = join(base, "status");
		dataDir1 = join(base, "data", "pet1");
		dataDir2 = join(base, "data", "pet2");
		configDir1 = join(base, "config", "pet1");
		configDir2 = join(base, "config", "pet2");
		await mkdir(statusDir, { recursive: true });
		await mkdir(dataDir1, { recursive: true });
		await mkdir(dataDir2, { recursive: true });
		await mkdir(configDir1, { recursive: true });
		await mkdir(configDir2, { recursive: true });
	});

	it("discovers pets from status files", async () => {
		await writeFile(
			join(statusDir, "pet1.json"),
			makeStatusFile("pet1", Date.now()),
		);
		await writeFile(
			join(statusDir, "pet2.json"),
			makeStatusFile("pet2", Date.now()),
		);

		const discovery = new PetDiscovery(statusDir, [dataDir1, dataDir2]);
		const pets = await discovery.discoverPets();

		expect(pets).toHaveLength(2);
		expect(pets.map((p) => p.id)).toContain("pet1");
		expect(pets.map((p) => p.id)).toContain("pet2");
	});

	it("marks pet as online when heartbeat is recent", async () => {
		await writeFile(
			join(statusDir, "pet1.json"),
			makeStatusFile("pet1", Date.now()),
		);

		const discovery = new PetDiscovery(statusDir, [dataDir1]);
		const pets = await discovery.discoverPets();

		expect(pets[0]?.isOnline).toBe(true);
	});

	it("marks pet as offline when heartbeat is stale (>60s)", async () => {
		const staleTime = Date.now() - 120_000; // 2 minutes ago
		await writeFile(
			join(statusDir, "pet1.json"),
			makeStatusFile("pet1", staleTime),
		);

		const discovery = new PetDiscovery(statusDir, [dataDir1]);
		const pets = await discovery.discoverPets();

		expect(pets[0]?.isOnline).toBe(false);
		expect(pets[0]?.lastSeen).toBe(staleTime);
	});

	it("returns empty list when status dir is empty", async () => {
		const discovery = new PetDiscovery(statusDir, [dataDir1]);
		const pets = await discovery.discoverPets();
		expect(pets).toEqual([]);
	});

	it("returns empty list when status dir does not exist", async () => {
		const discovery = new PetDiscovery(join(statusDir, "nonexistent"), [
			dataDir1,
		]);
		const pets = await discovery.discoverPets();
		expect(pets).toEqual([]);
	});

	it("skips malformed status files", async () => {
		await writeFile(join(statusDir, "bad.json"), "NOT_JSON");
		await writeFile(
			join(statusDir, "good.json"),
			makeStatusFile("good", Date.now()),
		);

		const discovery = new PetDiscovery(statusDir, [dataDir1]);
		const pets = await discovery.discoverPets();

		expect(pets).toHaveLength(1);
		expect(pets[0]?.id).toBe("good");
	});

	it("includes knowledge and relationship counts from data dirs", async () => {
		// Write knowledge entries
		const knowledgeDir = join(dataDir1, "knowledge");
		await mkdir(knowledgeDir, { recursive: true });
		await writeFile(
			join(knowledgeDir, "k1.json"),
			JSON.stringify({
				id: "k1",
				topic: "test",
				content: "content",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: [],
			}),
		);

		// Write relationship entries
		const relDir = join(dataDir1, "relationships");
		await mkdir(relDir, { recursive: true });
		await writeFile(
			join(relDir, "r1.json"),
			JSON.stringify({
				userId: "r1",
				displayName: "User1",
				firstSeen: Date.now(),
				lastSeen: Date.now(),
				interactionCount: 1,
				notes: [],
				preferences: [],
				sentiment: "neutral",
			}),
		);

		await writeFile(
			join(statusDir, "pet1.json"),
			makeStatusFile("pet1", Date.now()),
		);

		const discovery = new PetDiscovery(statusDir, [dataDir1]);
		const pets = await discovery.discoverPets();

		expect(pets[0]?.knowledgeCount).toBe(1);
		expect(pets[0]?.relationshipCount).toBe(1);
	});
});
