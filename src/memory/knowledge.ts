/**
 * Knowledge store — facts and teachings persisted across sessions.
 * Reference: OpenClaw memory-core short-term-promotion pattern.
 *
 * Includes Ebbinghaus forgetting curve decay:
 * - strength field tracks knowledge retention (0..1)
 * - Decays over time, reinforced on reference
 * - Weak entries archived to cold storage
 */

import { z } from "zod";
import {
	ARCHIVE_THRESHOLD,
	DEPRIORITIZE_THRESHOLD,
	computeDecayedStrength,
	computeReinforcedStrength,
} from "./decay.js";
import { FileMemoryStore } from "./store.js";

const KnowledgeEntrySchema = z.object({
	id: z.string(),
	topic: z.string(),
	content: z.string(),
	source: z.enum(["taught", "inferred", "corrected"]),
	taughtBy: z.string().optional(),
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
	async upsert(entry: Omit<KnowledgeEntry, "updatedAt">): Promise<void> {
		const withTimestamp: KnowledgeEntry = {
			...entry,
			updatedAt: Date.now(),
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
	 * increments referenceCount.
	 */
	async reinforce(id: string): Promise<void> {
		const entry = await this.store.read(id);
		if (!entry) return;

		const reinforced: KnowledgeEntry = {
			...entry,
			strength: computeReinforcedStrength(entry.strength),
			lastReferencedAt: Date.now(),
			referenceCount: entry.referenceCount + 1,
			updatedAt: Date.now(),
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

	/** Search knowledge by keyword matching (simple substring search). */
	async search(query: string, limit = 10): Promise<KnowledgeEntry[]> {
		const all = await this.store.readAll();
		const queryLower = query.toLowerCase();

		const scored = all
			.map(({ value }) => ({
				entry: value,
				score: computeRelevance(value, queryLower),
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

function computeRelevance(entry: KnowledgeEntry, queryLower: string): number {
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

	return score;
}
