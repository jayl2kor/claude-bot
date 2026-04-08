/**
 * Knowledge store — facts and teachings persisted across sessions.
 * Reference: OpenClaw memory-core short-term-promotion pattern.
 */

import { z } from "zod";
import { FileMemoryStore } from "./store.js";

const KnowledgeEntrySchema = z.object({
	id: z.string(),
	topic: z.string(),
	content: z.string(),
	source: z.enum(["taught", "inferred", "corrected", "propagated"]),
	taughtBy: z.string().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	confidence: z.number().min(0).max(1).default(0.8),
	tags: z.array(z.string()).default([]),
});

export type KnowledgeEntry = z.output<typeof KnowledgeEntrySchema>;

export class KnowledgeManager {
	private readonly store: FileMemoryStore<typeof KnowledgeEntrySchema>;

	constructor(memoryDir: string) {
		this.store = new FileMemoryStore(memoryDir, KnowledgeEntrySchema);
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

	/** Search knowledge by keyword matching (simple substring search). */
	async search(query: string, limit = 10): Promise<KnowledgeEntry[]> {
		const all = await this.store.readAll();
		const queryLower = query.toLowerCase();

		const scored = all
			.map(({ value }) => ({
				entry: value,
				score: computeRelevance(value, queryLower),
			}))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		return scored.map(({ entry }) => entry);
	}

	/** Get all knowledge entries. */
	async listAll(): Promise<KnowledgeEntry[]> {
		const entries = await this.store.readAll();
		return entries.map((e) => e.value);
	}

	/** Format relevant knowledge for prompt injection. */
	async toPromptSection(query: string, limit = 5): Promise<string | null> {
		const relevant = await this.search(query, limit);
		if (relevant.length === 0) return null;

		const lines = ["# 관련 지식"];
		for (const entry of relevant) {
			lines.push(`- [${entry.topic}] ${entry.content}`);
			if (entry.source === "corrected") {
				lines.push("  (수정된 정보 — 이전 답변이 틀렸던 것)");
			}
		}
		return lines.join("\n");
	}
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

	// Boost by confidence
	score *= entry.confidence;

	return score;
}
