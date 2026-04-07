/**
 * Session reflection — summaries of what was learned in each conversation.
 * Reference: OpenClaw memory-core dreaming pattern.
 *
 * After a session ends, a reflection is generated capturing key insights.
 * Recent reflections are injected into the prompt to provide continuity.
 */

import { z } from "zod";
import { FileMemoryStore } from "./store.js";

const ReflectionSchema = z.object({
	id: z.string(),
	sessionKey: z.string(),
	userId: z.string(),
	summary: z.string(),
	insights: z.array(z.string()).default([]),
	createdAt: z.number(),
});

export type Reflection = z.output<typeof ReflectionSchema>;

export class ReflectionManager {
	private readonly store: FileMemoryStore<typeof ReflectionSchema>;

	constructor(memoryDir: string) {
		this.store = new FileMemoryStore(memoryDir, ReflectionSchema);
	}

	/** Save a new reflection. */
	async save(reflection: Reflection): Promise<void> {
		await this.store.write(reflection.id, reflection);
	}

	/** Get most recent reflections, sorted by time descending. */
	async getRecent(limit = 5): Promise<Reflection[]> {
		const all = await this.store.readAll();
		return all
			.map((e) => e.value)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	}

	/** Get reflections for a specific user. */
	async getByUser(userId: string, limit = 5): Promise<Reflection[]> {
		const all = await this.store.readAll();
		return all
			.map((e) => e.value)
			.filter((r) => r.userId === userId)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	}

	/** Format recent reflections for prompt injection. */
	async toPromptSection(limit = 3): Promise<string | null> {
		const recent = await this.getRecent(limit);
		if (recent.length === 0) return null;

		const lines = ["# 최근 대화에서 배운 것"];
		for (const ref of recent) {
			const date = new Date(ref.createdAt).toLocaleDateString("ko-KR");
			lines.push(`\n## ${date}`);
			lines.push(ref.summary);
			if (ref.insights.length > 0) {
				for (const insight of ref.insights) {
					lines.push(`- ${insight}`);
				}
			}
		}
		return lines.join("\n");
	}
}
