/**
 * Persona system — Bones + Soul pattern.
 * Reference: Claude-code buddy/companion.ts
 *
 * Bones: Static config (persona.yaml) — user-defined, deterministic.
 * Soul: Learned traits (data/memory/persona.json) — evolves through interaction.
 * Composite: Merged at runtime for prompt injection.
 */

import { z } from "zod";
import type { PersonaConfig } from "../utils/config.js";
import { FileMemoryStore } from "./store.js";

const PersonaSoulSchema = z.object({
	learnedTraits: z.array(z.string()).default([]),
	preferredTopics: z.array(z.string()).default([]),
	communicationStyle: z.string().default(""),
	evolvedAt: z.number().default(0),
});

export type PersonaSoul = z.output<typeof PersonaSoulSchema>;

export type Persona = {
	// From bones (config)
	name: string;
	personality: string;
	tone: "casual" | "formal" | "playful";
	values: string[];
	constraints: string[];
	// From soul (learned)
	learnedTraits: string[];
	preferredTopics: string[];
	communicationStyle: string;
};

export class PersonaManager {
	private readonly soulStore: FileMemoryStore<typeof PersonaSoulSchema>;

	constructor(
		private readonly bones: PersonaConfig,
		memoryDir: string,
	) {
		this.soulStore = new FileMemoryStore(memoryDir, PersonaSoulSchema);
	}

	/** Get the composite persona (bones + soul merged). */
	async getPersona(): Promise<Persona> {
		const soul =
			(await this.soulStore.read("persona")) ?? PersonaSoulSchema.parse({});

		return {
			name: this.bones.name,
			personality: this.bones.personality,
			tone: this.bones.tone,
			values: this.bones.values,
			constraints: this.bones.constraints,
			learnedTraits: soul.learnedTraits,
			preferredTopics: soul.preferredTopics,
			communicationStyle: soul.communicationStyle,
		};
	}

	/** Update soul with new learned traits. Immutable — creates new object. */
	async updateSoul(update: Partial<PersonaSoul>): Promise<void> {
		const current =
			(await this.soulStore.read("persona")) ?? PersonaSoulSchema.parse({});
		const updated: PersonaSoul = {
			...current,
			...update,
			evolvedAt: Date.now(),
		};
		await this.soulStore.write("persona", updated);
	}

	/** Format persona for system prompt injection. */
	async toPromptSection(): Promise<string> {
		const p = await this.getPersona();

		const lines = [
			`# 너의 정체성`,
			`이름: ${p.name}`,
			`성격: ${p.personality}`,
			`말투: ${p.tone === "casual" ? "반말, 친근하게" : p.tone === "formal" ? "존댓말, 정중하게" : "장난스럽고 유쾌하게"}`,
			`가치관: ${p.values.join(", ")}`,
		];

		if (p.constraints.length > 0) {
			lines.push(`제약: ${p.constraints.join("; ")}`);
		}

		if (p.learnedTraits.length > 0) {
			lines.push(`\n# 배운 특성`);
			for (const trait of p.learnedTraits) {
				lines.push(`- ${trait}`);
			}
		}

		if (p.communicationStyle) {
			lines.push(`\n소통 스타일: ${p.communicationStyle}`);
		}

		return lines.join("\n");
	}
}
