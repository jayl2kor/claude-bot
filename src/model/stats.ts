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

/** In-memory buffer for a single day's pending increments. */
interface PendingCounts {
	date: string;
	haiku: number;
	sonnet: number;
	opus: number;
	overrides: number;
}

export class ModelStatsTracker {
	private readonly store: FileMemoryStore<typeof DailyModelStatsSchema>;
	private readonly sessionCache = new Map<
		string,
		{ model: ModelTier; timestamp: number }
	>();
	private pending: PendingCounts = { date: todayKey(), haiku: 0, sonnet: 0, opus: 0, overrides: 0 };
	private flushPromise: Promise<void> | null = null;

	constructor(baseDir: string) {
		this.store = new FileMemoryStore(baseDir, DailyModelStatsSchema);
	}

	async record(tier: ModelTier, isOverride = false): Promise<void> {
		const date = todayKey();
		// Roll over the buffer if the date has changed.
		if (this.pending.date !== date) {
			this.pending = { date, haiku: 0, sonnet: 0, opus: 0, overrides: 0 };
		}
		// Increment synchronously — safe within Node.js single-threaded event loop.
		this.pending[tier] += 1;
		if (isOverride) this.pending.overrides += 1;

		// Debounce: if a flush is already in flight, let it carry the latest counts.
		if (this.flushPromise) return;

		this.flushPromise = this.flush().finally(() => {
			this.flushPromise = null;
		});
		await this.flushPromise;
	}

	private async flush(): Promise<void> {
		const { date, haiku, sonnet, opus, overrides } = this.pending;
		const existing = await this.store.read(date);
		const base = existing ?? emptyStats(date);

		const updated: DailyModelStats = {
			...base,
			haiku: { count: base.haiku.count + haiku },
			sonnet: { count: base.sonnet.count + sonnet },
			opus: { count: base.opus.count + opus },
			overrideCount: base.overrideCount + overrides,
		};

		// Reset pending counts before writing so any records that arrive
		// while we await the write are captured in the next flush.
		this.pending = { date, haiku: 0, sonnet: 0, opus: 0, overrides: 0 };

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
