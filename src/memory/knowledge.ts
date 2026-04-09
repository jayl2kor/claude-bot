/**
 * Knowledge store — facts and teachings persisted across sessions.
 * Reference: OpenClaw memory-core short-term-promotion pattern.
 *
 * Includes Ebbinghaus forgetting curve decay:
 * - strength field tracks knowledge retention (0..1)
 * - Decays over time, reinforced on reference
 * - Weak entries archived to cold storage
 *
 * Memory tiering (Issue #42):
 * - scratchpad: short-lived (TTL-based), immediate storage
 * - working: mid-term, promoted from scratchpad
 * - long-term: durable, verified knowledge
 */

import { z } from "zod";
import {
	ARCHIVE_THRESHOLD,
	DEPRIORITIZE_THRESHOLD,
	computeDecayedStrength,
	computeReinforcedStrength,
} from "./decay.js";
import { FileMemoryStore } from "./store.js";
import { logger } from "../utils/logger.js";

// Re-export decay multiplier helper for convenience
export { getDecayMultiplier } from "../expertise/decay.js";

/** Default scratchpad TTL: 1 hour in milliseconds. */
const DEFAULT_SCRATCHPAD_TTL_MS = 3_600_000;

/** Tier weight multipliers for search scoring. */
const TIER_MULTIPLIER: Record<string, number> = {
	"long-term": 1.3,
	"working": 1.0,
	"scratchpad": 0.7,
};

/** Promotion result returned by promoteTiers(). */
export type TierPromotionResult = {
	scratchpadToWorking: number;
	workingToLongTerm: number;
};

/** Tier statistics returned by getTierStats(). */
export type TierStats = {
	scratchpad: number;
	working: number;
	longTerm: number;
	total: number;
};

/**
 * Compute the promotion score for a knowledge entry.
 * promotionScore = referenceCount * 0.4 + confidence * 0.4 + (strength > 0.7 ? 0.2 : 0)
 */
function computePromotionScore(
	referenceCount: number,
	confidence: number,
	strength: number,
): number {
	return referenceCount * 0.4 + confidence * 0.4 + (strength > 0.7 ? 0.2 : 0);
}

const KnowledgeEntrySchema = z.object({
	id: z.string(),
	topic: z.string(),
	content: z.string(),
	source: z.enum(["taught", "inferred", "corrected", "propagated", "seeded", "self-studied"]),
	taughtBy: z.string().optional(),
	propagatedFrom: z.string().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	confidence: z.number().min(0).max(1).default(0.8),
	tags: z.array(z.string()).default([]),
	/** Knowledge retention strength (0..1). Decays over time. */
	strength: z.number().min(0).max(1).default(1.0),
	/** Timestamp (ms) when this entry was last referenced in a prompt. */
	lastReferencedAt: z.number().default(() => Date.now()),
	/** Number of times this entry has been referenced. */
	referenceCount: z.number().int().min(0).default(0),
	// -----------------------------------------------------------------------
	// Memory tier fields (Issue #42)
	// -----------------------------------------------------------------------
	/** Memory tier: scratchpad (short-lived) → working → long-term. */
	tier: z.enum(["scratchpad", "working", "long-term"]).default("scratchpad"),
	/** Timestamp (ms) when the entry last changed tier. */
	tierCreatedAt: z.number().default(() => Date.now()),
	/** Promotion score: referenceCount*0.4 + confidence*0.4 + (strength>0.7?0.2:0). */
	promotionScore: z.number().default(0),
	/** Custom TTL (ms) for scratchpad entries. Defaults to DEFAULT_SCRATCHPAD_TTL_MS if not set. */
	scratchpadTtlMs: z.number().optional(),
});

export type KnowledgeEntry = z.output<typeof KnowledgeEntrySchema>;

export type PromptSectionResult = {
	text: string;
	entryIds: string[];
};

export class KnowledgeManager {
	private readonly store: FileMemoryStore<typeof KnowledgeEntrySchema>;
	private readonly archiveStore: FileMemoryStore<typeof KnowledgeEntrySchema>;

	constructor(memoryDir: string, archiveDir?: string) {
		this.store = new FileMemoryStore(memoryDir, KnowledgeEntrySchema);
		this.archiveStore = new FileMemoryStore(
			archiveDir ?? `${memoryDir}/../archive/knowledge`,
			KnowledgeEntrySchema,
		);
	}

	async get(id: string): Promise<KnowledgeEntry | null> {
		return this.store.read(id);
	}

	/** Store a new knowledge entry or update existing one. */
	async upsert(
		entry: Omit<KnowledgeEntry, "updatedAt" | "tier" | "tierCreatedAt" | "promotionScore"> &
			Partial<Pick<KnowledgeEntry, "tier" | "tierCreatedAt" | "promotionScore">>,
	): Promise<void> {
		const now = Date.now();
		const withTimestamp: KnowledgeEntry = {
			tier: "scratchpad",
			...entry,
			updatedAt: now,
			tierCreatedAt: entry.tierCreatedAt ?? now,
			// Always recompute promotionScore from live field values
			promotionScore: computePromotionScore(
				entry.referenceCount,
				entry.confidence,
				entry.strength,
			),
		};
		await this.store.write(entry.id, withTimestamp);
	}

	/** Delete a knowledge entry. */
	async delete(id: string): Promise<void> {
		await this.store.delete(id);
	}

	/**
	 * Reinforce a single knowledge entry — called when it appears in a prompt.
	 * Increases strength by REINFORCE_DELTA, updates lastReferencedAt,
	 * increments referenceCount, and recalculates promotionScore.
	 */
	async reinforce(id: string): Promise<void> {
		const entry = await this.store.read(id);
		if (!entry) return;

		const newReferenceCount = entry.referenceCount + 1;
		const newStrength = computeReinforcedStrength(entry.strength);

		const reinforced: KnowledgeEntry = {
			...entry,
			strength: newStrength,
			lastReferencedAt: Date.now(),
			referenceCount: newReferenceCount,
			updatedAt: Date.now(),
			promotionScore: computePromotionScore(
				newReferenceCount,
				entry.confidence,
				newStrength,
			),
		};
		await this.store.write(id, reinforced);
	}

	/**
	 * Reinforce multiple entries in batch (fire-and-forget from context builder).
	 */
	async reinforceMany(ids: readonly string[]): Promise<void> {
		await Promise.all(ids.map((id) => this.reinforce(id)));
	}

	/**
	 * Apply decay to all knowledge entries based on elapsed time.
	 * Called periodically by the memory-decay cron job.
	 */
	async applyDecayAll(): Promise<void> {
		const all = await this.store.readAll();
		const now = Date.now();

		for (const { value: entry } of all) {
			const elapsedMs = now - entry.lastReferencedAt;
			const elapsedHours = elapsedMs / (1000 * 60 * 60);
			const decayedStrength = computeDecayedStrength(
				entry.strength,
				elapsedHours,
			);

			if (Math.abs(decayedStrength - entry.strength) > 0.001) {
				const updated: KnowledgeEntry = {
					...entry,
					strength: decayedStrength,
					updatedAt: Date.now(),
					promotionScore: computePromotionScore(
						entry.referenceCount,
						entry.confidence,
						decayedStrength,
					),
				};
				await this.store.write(entry.id, updated);
			}
		}
	}

	/**
	 * Archive entries whose strength fell below ARCHIVE_THRESHOLD.
	 * Moves them from main store to archive store (cold storage).
	 * @returns Number of entries archived.
	 */
	async archiveWeak(): Promise<number> {
		const all = await this.store.readAll();
		let archived = 0;

		for (const { value: entry } of all) {
			if (entry.strength < ARCHIVE_THRESHOLD) {
				await this.archiveStore.write(entry.id, entry);
				await this.store.delete(entry.id);
				archived++;
			}
		}

		return archived;
	}

	/**
	 * List entries with fading memories (between ARCHIVE and DEPRIORITIZE thresholds).
	 * These are candidates for the pet to naturally mention for reinforcement.
	 */
	async listFading(limit = 10): Promise<KnowledgeEntry[]> {
		const all = await this.store.readAll();
		return all
			.map(({ value }) => value)
			.filter(
				(e) =>
					e.strength >= ARCHIVE_THRESHOLD &&
					e.strength < DEPRIORITIZE_THRESHOLD,
			)
			.sort((a, b) => a.strength - b.strength)
			.slice(0, limit);
	}

	/** Search knowledge by keyword matching with tier-priority weighting. */
	async search(query: string, limit = 10): Promise<KnowledgeEntry[]> {
		const all = await this.store.readAll();
		const queryLower = query.toLowerCase();

		const scored = all
			.map(({ value }) => ({
				entry: value,
				score: computeRelevanceWithTier(value, queryLower),
			}))
			.filter(
				({ score, entry }) =>
					score > 0 && entry.strength >= DEPRIORITIZE_THRESHOLD,
			)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		return scored.map(({ entry }) => entry);
	}

	/** Get all knowledge entries. */
	async listAll(): Promise<KnowledgeEntry[]> {
		const entries = await this.store.readAll();
		return entries.map((e) => e.value);
	}

	/** Find entries with a similar topic (case-insensitive exact match). */
	async findByTopic(topic: string): Promise<KnowledgeEntry[]> {
		const all = await this.store.readAll();
		const topicLower = topic.toLowerCase().trim();
		return all
			.map((e) => e.value)
			.filter((e) => e.topic.toLowerCase().trim() === topicLower);
	}

	// -------------------------------------------------------------------------
	// Memory tier management (Issue #42)
	// -------------------------------------------------------------------------

	/**
	 * Expire scratchpad entries whose TTL has elapsed.
	 * Entries eligible for promotion are promoted instead of deleted.
	 * @returns Number of entries deleted (not counting promoted ones).
	 */
	async expireScratchpad(): Promise<number> {
		const all = await this.store.readAll();
		const now = Date.now();
		let removed = 0;

		for (const { value: entry } of all) {
			if (entry.tier !== "scratchpad") continue;

			const ttl = entry.scratchpadTtlMs ?? DEFAULT_SCRATCHPAD_TTL_MS;
			const age = now - entry.tierCreatedAt;
			if (age <= ttl) continue;

			// Check if eligible for promotion before deleting
			const eligibleForWorking =
				entry.referenceCount >= 2 || entry.confidence >= 0.85;

			if (eligibleForWorking) {
				// Promote to working instead of deleting
				const promoted: KnowledgeEntry = {
					...entry,
					tier: "working",
					tierCreatedAt: now,
					updatedAt: now,
					promotionScore: computePromotionScore(
						entry.referenceCount,
						entry.confidence,
						entry.strength,
					),
				};
				await this.store.write(entry.id, promoted);
				logger.debug("Scratchpad entry promoted to working (TTL expired)", {
					id: entry.id,
					topic: entry.topic,
				});
			} else {
				await this.store.delete(entry.id);
				removed++;
				logger.debug("Scratchpad entry expired and deleted", {
					id: entry.id,
					topic: entry.topic,
					ageMs: age,
				});
			}
		}

		return removed;
	}

	/**
	 * Evaluate all entries for tier promotion based on promotion rules:
	 * - scratchpad → working: referenceCount >= 2 OR confidence >= 0.85
	 * - working → long-term: referenceCount >= 5 AND confidence >= 0.8
	 * @returns Counts of promotions per tier transition.
	 */
	async promoteTiers(): Promise<TierPromotionResult> {
		const all = await this.store.readAll();
		const now = Date.now();
		let scratchpadToWorking = 0;
		let workingToLongTerm = 0;

		for (const { value: entry } of all) {
			if (entry.tier === "scratchpad") {
				const eligible =
					entry.referenceCount >= 2 || entry.confidence >= 0.85;
				if (!eligible) continue;

				const promoted: KnowledgeEntry = {
					...entry,
					tier: "working",
					tierCreatedAt: now,
					updatedAt: now,
					promotionScore: computePromotionScore(
						entry.referenceCount,
						entry.confidence,
						entry.strength,
					),
				};
				await this.store.write(entry.id, promoted);
				scratchpadToWorking++;
				logger.debug("Promoted scratchpad → working", {
					id: entry.id,
					topic: entry.topic,
					referenceCount: entry.referenceCount,
					confidence: entry.confidence,
				});
			} else if (entry.tier === "working") {
				const eligible =
					entry.referenceCount >= 5 && entry.confidence >= 0.8;
				if (!eligible) continue;

				const promoted: KnowledgeEntry = {
					...entry,
					tier: "long-term",
					tierCreatedAt: now,
					updatedAt: now,
					promotionScore: computePromotionScore(
						entry.referenceCount,
						entry.confidence,
						entry.strength,
					),
				};
				await this.store.write(entry.id, promoted);
				workingToLongTerm++;
				logger.debug("Promoted working → long-term", {
					id: entry.id,
					topic: entry.topic,
					referenceCount: entry.referenceCount,
					confidence: entry.confidence,
				});
			}
		}

		return { scratchpadToWorking, workingToLongTerm };
	}

	/**
	 * Run full tier maintenance cycle:
	 * 1. Expire TTL-elapsed scratchpad entries (promoting eligible ones)
	 * 2. Promote entries meeting promotion criteria
	 * Intended to be called by the memory-tier-maintenance cron job.
	 */
	async runTierMaintenance(): Promise<{
		expired: number;
		scratchpadToWorking: number;
		workingToLongTerm: number;
	}> {
		const expired = await this.expireScratchpad();
		const { scratchpadToWorking, workingToLongTerm } = await this.promoteTiers();
		return { expired, scratchpadToWorking, workingToLongTerm };
	}

	/**
	 * Get tier statistics for monitoring and logging.
	 * @returns Counts of entries per tier and total.
	 */
	async getTierStats(): Promise<TierStats> {
		const all = await this.store.readAll();
		const stats: TierStats = {
			scratchpad: 0,
			working: 0,
			longTerm: 0,
			total: 0,
		};

		for (const { value: entry } of all) {
			stats.total++;
			if (entry.tier === "long-term") {
				stats.longTerm++;
			} else if (entry.tier === "working") {
				stats.working++;
			} else {
				// "scratchpad" or any defaulted value
				stats.scratchpad++;
			}
		}

		return stats;
	}

	/**
	 * Format relevant knowledge for prompt injection.
	 * Returns { text, entryIds } so the caller can fire-and-forget reinforce.
	 */
	async toPromptSection(
		query: string,
		limit = 5,
	): Promise<PromptSectionResult | null> {
		const relevant = await this.search(query, limit);
		if (relevant.length === 0) return null;

		const entryIds = relevant.map((e) => e.id);

		const lines = ["# 관련 지식"];
		for (const entry of relevant) {
			const strengthPct = Math.round(entry.strength * 100);
			const bar = renderStrengthBar(entry.strength);
			lines.push(`- [${entry.topic}] ${entry.content} ${bar} ${strengthPct}%`);
			if (entry.source === "corrected") {
				lines.push("  (수정된 정보 — 이전 답변이 틀렸던 것)");
			}
		}

		return { text: lines.join("\n"), entryIds };
	}
}

/** Render a visual strength bar: ████░░ */
function renderStrengthBar(strength: number): string {
	const filled = Math.round(strength * 6);
	const empty = 6 - filled;
	return `[강도: ${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

/**
 * Compute relevance score with tier-priority weighting.
 * Applies tier multipliers: long-term(×1.3), working(×1.0), scratchpad(×0.7)
 */
function computeRelevanceWithTier(entry: KnowledgeEntry, queryLower: string): number {
	let score = 0;
	const topicLower = entry.topic.toLowerCase();
	const contentLower = entry.content.toLowerCase();
	const words = queryLower.split(/\s+/);

	for (const word of words) {
		if (word.length < 2) continue;
		if (topicLower.includes(word)) score += 3;
		if (contentLower.includes(word)) score += 1;
		if (entry.tags.some((t) => t.toLowerCase().includes(word))) score += 2;
	}

	// Boost by confidence and strength
	score *= entry.confidence * entry.strength;

	// Apply tier multiplier
	const tierMultiplier = TIER_MULTIPLIER[entry.tier] ?? 1.0;
	score *= tierMultiplier;

	return score;
}
