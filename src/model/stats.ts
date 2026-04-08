/**
 * Model usage stats tracker -- records daily model tier usage.
 *
 * Uses FileMemoryStore for persistence and maintains an in-memory
 * session model cache for session continuity lookups.
 */

import { z } from "zod";
import { FileMemoryStore } from "../memory/store.js";
import type { DailyModelStats, ModelTier } from "./types.js";

const DailyModelStatsSchema = z.object({
	date: z.string(),
	haiku: z.object({ count: z.number().default(0) }),
	sonnet: z.object({ count: z.number().default(0) }),
	opus: z.object({ count: z.number().default(0) }),
	overrideCount: z.number().default(0),
});

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

function emptyStats(date: string): DailyModelStats {
	return {
		date,
		haiku: { count: 0 },
		sonnet: { count: 0 },
		opus: { count: 0 },
		overrideCount: 0,
	};
}

export class ModelStatsTracker {
	private readonly store: FileMemoryStore<typeof DailyModelStatsSchema>;
	private readonly sessionCache = new Map<
		string,
		{ model: ModelTier; timestamp: number }
	>();

	constructor(baseDir: string) {
		this.store = new FileMemoryStore(baseDir, DailyModelStatsSchema);
	}

	async record(tier: ModelTier, isOverride = false): Promise<void> {
		const date = todayKey();
		const existing = await this.store.read(date);
		const stats = existing ?? emptyStats(date);

		const updated: DailyModelStats = {
			...stats,
			[tier]: { count: stats[tier].count + 1 },
			overrideCount: stats.overrideCount + (isOverride ? 1 : 0),
		};

		await this.store.write(date, updated);
	}

	async getDailyStats(date?: string): Promise<DailyModelStats | null> {
		return this.store.read(date ?? todayKey());
	}

	getSessionModel(
		sessionKey: string,
	): { model: ModelTier; timestamp: number } | undefined {
		return this.sessionCache.get(sessionKey);
	}

	setSessionModel(
		sessionKey: string,
		model: ModelTier,
		timestamp: number,
	): void {
		this.sessionCache.set(sessionKey, { model, timestamp });
	}
}
