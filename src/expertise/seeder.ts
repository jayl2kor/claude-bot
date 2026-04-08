/**
 * KnowledgeSeeder — imports pre-registered domain knowledge at boot.
 *
 * Reads JSON files from `config/{petId}/seed-knowledge/*.json`,
 * deduplicates via SHA-256 hash tracking (seed-state.json in data dir),
 * and creates entries with source: "seeded" and tag: "seeded".
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KnowledgeManager } from "../memory/knowledge.js";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { SeedKnowledgeEntrySchema, SeedStateSchema } from "./types.js";

export class KnowledgeSeeder {
	private readonly seedDir: string;
	private readonly dataDir: string;
	private readonly knowledge: KnowledgeManager;

	constructor(seedDir: string, dataDir: string, knowledge: KnowledgeManager) {
		this.seedDir = seedDir;
		this.dataDir = dataDir;
		this.knowledge = knowledge;
	}

	/** Seed knowledge from JSON files. Returns number of newly imported entries. */
	async seed(): Promise<number> {
		const entries = await this.loadSeedEntries();
		if (entries.length === 0) return 0;

		const state = await this.loadState();
		const existingHashes = new Set(state.importedHashes);
		let imported = 0;

		for (const entry of entries) {
			const hash = this.computeHash(entry.topic, entry.content);
			if (existingHashes.has(hash)) continue;

			const id = `seed-${randomUUID()}`;
			const now = Date.now();

			await this.knowledge.upsert({
				id,
				topic: entry.topic,
				content: entry.content,
				source: "seeded",
				createdAt: now,
				updatedAt: now,
				confidence: entry.confidence,
				tags: [...new Set([...entry.tags, "seeded"])],
			});

			existingHashes.add(hash);
			imported++;
		}

		if (imported > 0) {
			await this.saveState({
				importedHashes: [...existingHashes],
			});
			logger.info("Knowledge seeding completed", { imported });
		}

		return imported;
	}

	private computeHash(topic: string, content: string): string {
		return createHash("sha256").update(`${topic}::${content}`).digest("hex");
	}

	private async loadSeedEntries(): Promise<
		Array<{
			topic: string;
			content: string;
			tags: string[];
			confidence: number;
		}>
	> {
		try {
			const files = await readdir(this.seedDir);
			const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

			if (jsonFiles.length === 0) return [];

			const entries: Array<{
				topic: string;
				content: string;
				tags: string[];
				confidence: number;
			}> = [];

			for (const file of jsonFiles) {
				try {
					const raw = await readFile(join(this.seedDir, file), "utf8");
					const parsed = JSON.parse(raw);

					if (!Array.isArray(parsed)) continue;

					for (const item of parsed) {
						const result = SeedKnowledgeEntrySchema.safeParse(item);
						if (result.success) {
							entries.push(result.data);
						}
					}
				} catch {
					// Skip unreadable/invalid files
				}
			}

			return entries;
		} catch (err) {
			if (isENOENT(err)) return [];
			return [];
		}
	}

	private async loadState(): Promise<{ importedHashes: string[] }> {
		try {
			const raw = await readFile(this.statePath(), "utf8");
			const parsed = JSON.parse(raw);
			const result = SeedStateSchema.safeParse(parsed);
			return result.success ? result.data : { importedHashes: [] };
		} catch {
			return { importedHashes: [] };
		}
	}

	private async saveState(state: { importedHashes: string[] }): Promise<void> {
		const path = this.statePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(state, null, 2), "utf8");
	}

	private statePath(): string {
		return join(this.dataDir, "seed-state.json");
	}
}
