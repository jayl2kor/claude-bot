/**
 * System prompt builder — assembles persona + memory into a single prompt.
 * Reference: Claude-code buddy/prompt.ts companionIntroText()
 *
 * Combines persona, relationship, knowledge, and reflections
 * with token budget management per section.
 */

import type { KnowledgeManager } from "../memory/knowledge.js";
import type { PersonaManager } from "../memory/persona.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";

export type ContextBuilderDeps = {
	persona: PersonaManager;
	relationships: RelationshipManager;
	knowledge: KnowledgeManager;
	reflections: ReflectionManager;
};

/** Rough token estimate: ~4 chars per token for English, ~2 for Korean. */
function estimateTokens(text: string): number {
	const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;
	const otherChars = text.length - koreanChars;
	return Math.ceil(koreanChars / 2 + otherChars / 4);
}

/** Truncate text to fit within a token budget. */
function truncateToTokenBudget(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;

	// Binary search for the right cutoff
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(text.slice(0, mid)) <= budget) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return `${text.slice(0, lo)}...`;
}

const TOKEN_BUDGETS = {
	persona: 500,
	relationship: 400,
	knowledge: 1500,
	reflections: 600,
};

export class ContextBuilder {
	constructor(private readonly deps: ContextBuilderDeps) {}

	/**
	 * Build the complete system prompt for a session.
	 * Sections are ordered by importance; each has a token budget.
	 */
	async build(
		userId: string,
		_channelId: string,
		recentQuery?: string,
	): Promise<string> {
		// Parallel I/O — all four sections are independent
		const [personaSection, relSection, knowledgeSection, reflectionSection] =
			await Promise.all([
				this.deps.persona.toPromptSection(),
				this.deps.relationships.toPromptSection(userId),
				recentQuery
					? this.deps.knowledge.toPromptSection(recentQuery, 5)
					: Promise.resolve(null),
				this.deps.reflections.toPromptSection(3),
			]);

		const sections: string[] = [];
		sections.push(truncateToTokenBudget(personaSection, TOKEN_BUDGETS.persona));
		if (relSection) {
			sections.push(
				truncateToTokenBudget(relSection, TOKEN_BUDGETS.relationship),
			);
		}
		if (knowledgeSection) {
			sections.push(
				truncateToTokenBudget(knowledgeSection, TOKEN_BUDGETS.knowledge),
			);
		}
		if (reflectionSection) {
			sections.push(
				truncateToTokenBudget(reflectionSection, TOKEN_BUDGETS.reflections),
			);
		}

		// 5. Meta instructions
		sections.push(buildMetaInstructions());

		return sections.join("\n\n");
	}
}

function buildMetaInstructions(): string {
	return [
		"# 행동 지침",
		"- 사용자가 무언가를 가르치면, 그것을 기억하겠다고 확인해줘",
		"- 이전 대화에서 배운 것이 있으면 자연스럽게 활용해",
		"- 모르는 것은 솔직하게 모른다고 말해",
		"- **반드시 사용자에게 텍스트 답변을 먼저 한 후에** 도구를 사용해라. 도구 사용 전에 항상 먼저 말해라.",
		`- 현재 시각: ${new Date().toLocaleString("ko-KR")}`,
	].join("\n");
}
