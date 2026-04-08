/**
 * Tests for dashboard API routes using Hono testClient pattern.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { PetDataReader } from "../data-reader.js";
import { PetDiscovery } from "../pet-discovery.js";
import { createHealthRoute } from "./health.js";
import { createKnowledgeRoute } from "./knowledge.js";
import { createPetsRoute } from "./pets.js";
import { createStatsRoute } from "./stats.js";

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-routes-test-${randomUUID()}`);
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

describe("Dashboard API Routes", () => {
	let statusDir: string;
	let dataDir: string;
	let configDir: string;
	let app: Hono;

	beforeEach(async () => {
		const base = makeTempDir();
		statusDir = join(base, "status");
		dataDir = join(base, "data", "testpet");
		configDir = join(base, "config", "testpet");
		await mkdir(statusDir, { recursive: true });
		await mkdir(join(dataDir, "knowledge"), { recursive: true });
		await mkdir(join(dataDir, "relationships"), { recursive: true });
		await mkdir(join(dataDir, "reflections"), { recursive: true });
		await mkdir(join(dataDir, "activity"), { recursive: true });
		await mkdir(join(dataDir, "persona"), { recursive: true });
		await mkdir(configDir, { recursive: true });

		const discovery = new PetDiscovery(statusDir, [dataDir]);
		const readers = new Map<string, PetDataReader>();
		readers.set("testpet", new PetDataReader(dataDir, configDir));

		app = new Hono();
		app.route("/api", createHealthRoute());
		app.route("/api", createPetsRoute(discovery));
		app.route("/api", createStatsRoute(readers));
		app.route("/api", createKnowledgeRoute(readers));
	});

	describe("GET /api/health", () => {
		it("returns ok status", async () => {
			const res = await app.request("/api/health");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.status).toBe("ok");
		});
	});

	describe("GET /api/pets", () => {
		it("returns empty list when no pets", async () => {
			const res = await app.request("/api/pets");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.success).toBe(true);
			expect(body.data).toEqual([]);
		});

		it("returns pet summaries", async () => {
			await writeFile(
				join(statusDir, "testpet.json"),
				makeStatusFile("testpet", Date.now()),
			);

			const res = await app.request("/api/pets");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.success).toBe(true);
			expect(body.data).toHaveLength(1);
			expect(body.data[0].id).toBe("testpet");
			expect(body.data[0].isOnline).toBe(true);
		});
	});

	describe("GET /api/pets/:id/stats", () => {
		it("returns 404 for unknown pet", async () => {
			const res = await app.request("/api/pets/unknown/stats");
			expect(res.status).toBe(404);

			const body = await res.json();
			expect(body.success).toBe(false);
		});

		it("returns stats for known pet", async () => {
			await writeFile(
				join(dataDir, "knowledge", "k1.json"),
				JSON.stringify({
					id: "k1",
					topic: "Test",
					content: "test content",
					source: "taught",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					confidence: 0.8,
					tags: [],
				}),
			);

			const res = await app.request("/api/pets/testpet/stats");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.success).toBe(true);
			expect(body.data.knowledge.total).toBe(1);
		});
	});

	describe("GET /api/pets/:id/knowledge", () => {
		it("returns paginated knowledge", async () => {
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

			const res = await app.request(
				"/api/pets/testpet/knowledge?page=1&limit=3",
			);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.success).toBe(true);
			expect(body.data).toHaveLength(3);
			expect(body.meta.total).toBe(5);
			expect(body.meta.page).toBe(1);
			expect(body.meta.limit).toBe(3);
		});

		it("supports search query", async () => {
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

			const res = await app.request("/api/pets/testpet/knowledge?q=typescript");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data).toHaveLength(1);
			expect(body.data[0].topic).toBe("TypeScript");
		});
	});
});
