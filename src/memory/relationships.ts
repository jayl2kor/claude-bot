/**
 * Per-user relationship tracking.
 * Remembers who each user is, their preferences, and interaction history.
 */

import { z } from "zod";
import { FileMemoryStore } from "./store.js";

const RelationshipSchema = z.object({
	userId: z.string(),
	displayName: z.string(),
	firstSeen: z.number(),
	lastSeen: z.number(),
	interactionCount: z.number().default(0),
	notes: z.array(z.string()).default([]),
	preferences: z.array(z.string()).default([]),
	sentiment: z.enum(["positive", "neutral", "cautious"]).default("neutral"),
});

export type Relationship = z.output<typeof RelationshipSchema>;

export class RelationshipManager {
	private readonly store: FileMemoryStore<typeof RelationshipSchema>;

	constructor(memoryDir: string) {
		this.store = new FileMemoryStore(memoryDir, RelationshipSchema);
	}

	async get(userId: string): Promise<Relationship | null> {
		return this.store.read(userId);
	}

	/** Record an interaction. Creates new relationship if first time. */
	async recordInteraction(
		userId: string,
		displayName: string,
	): Promise<Relationship> {
		const now = Date.now();
		const existing = await this.store.read(userId);

		const updated: Relationship = existing
			? {
					...existing,
					displayName,
					lastSeen: now,
					interactionCount: existing.interactionCount + 1,
				}
			: {
					userId,
					displayName,
					firstSeen: now,
					lastSeen: now,
					interactionCount: 1,
					notes: [],
					preferences: [],
					sentiment: "neutral",
				};

		await this.store.write(userId, updated);
		return updated;
	}

	/** Add a note about this user. */
	async addNote(userId: string, note: string): Promise<void> {
		const rel = await this.store.read(userId);
		if (!rel) return;

		await this.store.write(userId, {
			...rel,
			notes: [...rel.notes, note],
		});
	}

	/** Add a preference for this user. */
	async addPreference(userId: string, preference: string): Promise<void> {
		const rel = await this.store.read(userId);
		if (!rel) return;

		await this.store.write(userId, {
			...rel,
			preferences: [...rel.preferences, preference],
		});
	}

	/** Format relationship for prompt injection. */
	async toPromptSection(userId: string): Promise<string | null> {
		const rel = await this.store.read(userId);
		if (!rel) return null;

		const lines = [`# ${rel.displayName}에 대한 기억`];
		lines.push(
			`처음 만남: ${new Date(rel.firstSeen).toLocaleDateString("ko-KR")}`,
		);
		lines.push(`대화 횟수: ${rel.interactionCount}회`);

		if (rel.notes.length > 0) {
			lines.push("\n메모:");
			for (const note of rel.notes.slice(-10)) {
				lines.push(`- ${note}`);
			}
		}

		if (rel.preferences.length > 0) {
			lines.push("\n선호사항:");
			for (const pref of rel.preferences.slice(-5)) {
				lines.push(`- ${pref}`);
			}
		}

		return lines.join("\n");
	}

	async listAll(): Promise<Relationship[]> {
		const entries = await this.store.readAll();
		return entries.map((e) => e.value);
	}
}
