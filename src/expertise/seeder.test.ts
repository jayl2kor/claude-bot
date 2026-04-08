/**
 * Tests for KnowledgeSeeder — covers:
 * - Import seed knowledge entries
 * - SHA-256 dedup via hash tracking
 * - Re-import skips already imported entries
 * - Topic similarity check
 * - Creates entries with source: "seeded" and tag: "seeded"
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KnowledgeManager } from "../memory/knowledge.js";
import { KnowledgeSeeder } from "./seeder.js";

async function makeTempDir(): Promise<string> {
	const dir = join(tmpdir(), `claude-pet-seeder-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

function makeSeedFile(
	entries: Array<{
		topic: string;
		content: string;
		tags?: string[];
		confidence?: number;
	}>,
): string {
	return JSON.stringify(entries);
}

describe("KnowledgeSeeder", () => {
	let seedDir: string;
	let dataDir: string;
	let knowledgeDir: string;
	let knowledge: KnowledgeManager;
	let seeder: KnowledgeSeeder;

	beforeEach(async () => {
		seedDir = await makeTempDir();
		dataDir = await makeTempDir();
		knowledgeDir = join(dataDir, "knowledge");
		await mkdir(knowledgeDir, { recursive: true });
		knowledge = new KnowledgeManager(knowledgeDir);
		seeder = new KnowledgeSeeder(seedDir, dataDir, knowledge);
	});

	it("imports seed entries into knowledge store", async () => {
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([
				{
					topic: "Docker basics",
					content: "Containers provide isolation",
					tags: ["docker"],
				},
			]),
			"utf8",
		);

		const imported = await seeder.seed();
		expect(imported).toBe(1);

		const all = await knowledge.listAll();
		expect(all).toHaveLength(1);
		expect(all[0]?.topic).toBe("Docker basics");
		expect(all[0]?.source).toBe("seeded");
		expect(all[0]?.tags).toContain("seeded");
		expect(all[0]?.tags).toContain("docker");
	});

	it("imports multiple entries from multiple files", async () => {
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([
				{ topic: "Docker A", content: "A content", tags: [] },
				{ topic: "Docker B", content: "B content", tags: [] },
			]),
			"utf8",
		);
		await writeFile(
			join(seedDir, "k8s.json"),
			makeSeedFile([{ topic: "K8s C", content: "C content", tags: [] }]),
			"utf8",
		);

		const imported = await seeder.seed();
		expect(imported).toBe(3);

		const all = await knowledge.listAll();
		expect(all).toHaveLength(3);
	});

	it("skips already-imported entries on re-import (hash dedup)", async () => {
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([
				{
					topic: "Docker basics",
					content: "Containers provide isolation",
					tags: [],
				},
			]),
			"utf8",
		);

		const first = await seeder.seed();
		expect(first).toBe(1);

		// Re-seed — should skip
		const second = await seeder.seed();
		expect(second).toBe(0);

		const all = await knowledge.listAll();
		expect(all).toHaveLength(1);
	});

	it("persists seed state (importedHashes) to disk", async () => {
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([{ topic: "Docker", content: "Content", tags: [] }]),
			"utf8",
		);

		await seeder.seed();

		// Read the seed-state.json file
		const stateRaw = await readFile(join(dataDir, "seed-state.json"), "utf8");
		const state = JSON.parse(stateRaw);
		expect(state.importedHashes).toHaveLength(1);
		expect(typeof state.importedHashes[0]).toBe("string");
	});

	it("returns 0 when seed directory does not exist", async () => {
		const nonexistentSeeder = new KnowledgeSeeder(
			join(seedDir, "nonexistent"),
			dataDir,
			knowledge,
		);
		const imported = await nonexistentSeeder.seed();
		expect(imported).toBe(0);
	});

	it("returns 0 when seed directory is empty", async () => {
		const imported = await seeder.seed();
		expect(imported).toBe(0);
	});

	it("ignores non-json files", async () => {
		await writeFile(join(seedDir, "readme.md"), "# README", "utf8");
		const imported = await seeder.seed();
		expect(imported).toBe(0);
	});

	it("sets confidence from seed entry", async () => {
		await writeFile(
			join(seedDir, "data.json"),
			makeSeedFile([
				{
					topic: "High confidence",
					content: "Very sure",
					tags: [],
					confidence: 0.95,
				},
			]),
			"utf8",
		);

		await seeder.seed();
		const all = await knowledge.listAll();
		expect(all[0]?.confidence).toBe(0.95);
	});

	it("handles new entries after initial import", async () => {
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([{ topic: "Docker A", content: "Content A", tags: [] }]),
			"utf8",
		);
		await seeder.seed();

		// Add new entries to the same file
		await writeFile(
			join(seedDir, "docker.json"),
			makeSeedFile([
				{ topic: "Docker A", content: "Content A", tags: [] },
				{ topic: "Docker B", content: "Content B", tags: [] },
			]),
			"utf8",
		);

		const imported = await seeder.seed();
		expect(imported).toBe(1); // Only Docker B is new

		const all = await knowledge.listAll();
		expect(all).toHaveLength(2);
	});
});
