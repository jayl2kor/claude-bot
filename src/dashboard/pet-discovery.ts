/**
 * Pet discovery — scans shared-status directory and data directories
 * to find running pets and determine their online/offline status.
 * All access is read-only.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PetStatusSchema } from "../status/types.js";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { PetSummary } from "./types.js";

const STALE_THRESHOLD_MS = 60_000; // 60 seconds

export class PetDiscovery {
	constructor(
		private readonly statusDir: string,
		private readonly dataDirs: readonly string[],
	) {}

	/** Discover all pets by scanning status files. */
	async discoverPets(): Promise<PetSummary[]> {
		const statusMap = await this.readStatusFiles();
		const summaries: PetSummary[] = [];

		for (const [petId, status] of statusMap) {
			const dataDir = this.findDataDir(petId);
			const counts = dataDir
				? await this.countEntries(dataDir)
				: { knowledge: 0, relationships: 0 };

			const isOnline = Date.now() - status.heartbeatAt < STALE_THRESHOLD_MS;

			summaries.push({
				id: petId,
				name: status.personaName,
				isOnline,
				lastSeen: isOnline ? undefined : status.heartbeatAt,
				knowledgeCount: counts.knowledge,
				relationshipCount: counts.relationships,
			});
		}

		return summaries;
	}

	private async readStatusFiles(): Promise<
		Map<string, { personaName: string; heartbeatAt: number }>
	> {
		const result = new Map<
			string,
			{ personaName: string; heartbeatAt: number }
		>();

		try {
			const files = await readdir(this.statusDir);

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				try {
					const raw = await readFile(join(this.statusDir, file), "utf8");
					const parsed = PetStatusSchema.safeParse(JSON.parse(raw));
					if (!parsed.success) continue;

					result.set(parsed.data.petId, {
						personaName: parsed.data.personaName,
						heartbeatAt: parsed.data.heartbeatAt,
					});
				} catch {
					// Corrupted or mid-write — skip
				}
			}
		} catch (err) {
			if (isENOENT(err)) return result;
			logger.warn("Failed to read status directory", { error: String(err) });
		}

		return result;
	}

	private findDataDir(petId: string): string | undefined {
		return this.dataDirs.find((dir) => dir.endsWith(petId));
	}

	private async countEntries(
		dataDir: string,
	): Promise<{ knowledge: number; relationships: number }> {
		const [knowledge, relationships] = await Promise.all([
			this.countJsonFiles(join(dataDir, "knowledge")),
			this.countJsonFiles(join(dataDir, "relationships")),
		]);
		return { knowledge, relationships };
	}

	private async countJsonFiles(dir: string): Promise<number> {
		try {
			const files = await readdir(dir);
			return files.filter((f) => f.endsWith(".json")).length;
		} catch (err) {
			if (isENOENT(err)) return 0;
			logger.warn("Failed to count files", { dir, error: String(err) });
			return 0;
		}
	}
}
