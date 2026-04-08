/**
 * System prompt builder — assembles persona + memory into a single prompt.
 * Reference: Claude-code buddy/prompt.ts companionIntroText()
 *
 * Combines persona, relationship, knowledge, and reflections
 * with token budget management per section.
 */

import { readFile } from "node:fs/promises";
import type { DelegationBuilder } from "../expertise/defer.js";
import type { ExpertiseDocLoader } from "../expertise/loader.js";
import type { ChatHistoryManager } from "../memory/history.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { PersonaManager } from "../memory/persona.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import type { ChannelChatMessage } from "../plugins/types.js";
import type { StatusReader } from "../status/reader.js";
import { truncateToTokenBudget } from "../utils/tokens.js";

export type ContextBuilderDeps = {
	persona: PersonaManager;
	relationships: RelationshipManager;
	knowledge: KnowledgeManager;
	reflections: ReflectionManager;
	history?: ChatHistoryManager;
	statusReader?: StatusReader;
	/** Path to a knowledge.md file with static knowledge for this pet. */
	knowledgeFilePath?: string;
	/** Path to common knowledge.md shared by all pets. */
	commonKnowledgeFilePath?: string;
	/** Expertise domain knowledge docs loader. */
	expertiseDocLoader?: ExpertiseDocLoader;
	/** Delegation builder for cross-pet topic routing. */
	delegationBuilder?: DelegationBuilder;
};

const TOKEN_BUDGETS = {
	persona: 500,
	relationship: 400,
	knowledge: 1500,
	reflections: 600,
	review: 400,
};

export class ContextBuilder {
	constructor(private readonly deps: ContextBuilderDeps) {}

	/**
	 * Build the complete system prompt for a session.
	 * Sections are ordered by importance; each has a token budget.
	 */
	async build(
		userId: string,
		channelId: string,
		recentQuery?: string,
		recentMessages?: ChannelChatMessage[],
	): Promise<string> {
		// Parallel I/O — all sections are independent
		const historyPromise =
			this.deps.history && recentQuery && hasBackReference(recentQuery)
				? this.deps.history.search(channelId, {
						keyword: extractReferenceKeyword(recentQuery),
						limit: 10,
					})
				: Promise.resolve([]);

		const [
			personaSection,
			relSection,
			knowledgeResult,
			reflectionSection,
			historyResults,
			statusSection,
			expertiseDocsSection,
			delegationSection,
		] = await Promise.all([
			this.deps.persona.toPromptSection(),
			this.deps.relationships.toPromptSection(userId),
			recentQuery
				? this.deps.knowledge.toPromptSection(recentQuery, 5)
				: Promise.resolve(null),
			this.deps.reflections.toPromptSection(3),
			historyPromise,
			this.deps.statusReader?.toPromptSection() ?? Promise.resolve(null),
			this.deps.expertiseDocLoader?.toPromptSection() ?? Promise.resolve(null),
			this.deps.delegationBuilder?.toPromptSection() ?? Promise.resolve(null),
		]);

		// Fire-and-forget: reinforce knowledge entries included in prompt
		if (knowledgeResult?.entryIds.length) {
			void this.deps.knowledge.reinforceMany(knowledgeResult.entryIds);
		}

		const sections: string[] = [];
		sections.push(truncateToTokenBudget(personaSection, TOKEN_BUDGETS.persona));

		// Static knowledge file (knowledge.md)
		if (this.deps.knowledgeFilePath) {
			try {
				const knowledgeFileContent = await readFile(
					this.deps.knowledgeFilePath,
					"utf8",
				);
				if (knowledgeFileContent.trim()) {
					sections.push(truncateToTokenBudget(knowledgeFileContent, 1000));
				}
			} catch {
				// File not found or unreadable — skip
			}
		}

		// Common knowledge shared by all pets
		if (this.deps.commonKnowledgeFilePath) {
			try {
				const commonContent = await readFile(
					this.deps.commonKnowledgeFilePath,
					"utf8",
				);
				if (commonContent.trim()) {
					sections.push(truncateToTokenBudget(commonContent, 400));
				}
			} catch {
				// File not found or unreadable — skip
			}
		}

		// Expertise domain knowledge docs (2500 token budget, managed by loader)
		if (expertiseDocsSection) {
			sections.push(expertiseDocsSection);
		}

		// Delegation awareness (400 token budget, managed by builder)
		if (delegationSection) {
			sections.push(delegationSection);
		}

		if (relSection) {
			sections.push(
				truncateToTokenBudget(relSection, TOKEN_BUDGETS.relationship),
			);
		}
		if (knowledgeResult) {
			sections.push(
				truncateToTokenBudget(knowledgeResult.text, TOKEN_BUDGETS.knowledge),
			);
		}
		if (reflectionSection) {
			sections.push(
				truncateToTokenBudget(reflectionSection, TOKEN_BUDGETS.reflections),
			);
		}

		// 5. Recent channel conversation context
		if (recentMessages && recentMessages.length > 0) {
			const chatLines = ["# 최근 채널 대화 (이전 메시지들)"];
			for (const m of recentMessages) {
				const tag = m.isBot ? "(봇)" : "";
				chatLines.push(`${m.userName}${tag}: ${m.content}`);
			}
			sections.push(chatLines.join("\n"));
		}

		// 6. Referenced past conversation (from history search)
		if (historyResults.length > 0) {
			const histLines = ['# 과거 대화 참조 ("아까 그거" 관련)'];
			for (const h of historyResults) {
				const date = new Date(h.timestamp).toLocaleString("ko-KR");
				histLines.push(`[${date}] ${h.userName}: ${h.content.slice(0, 200)}`);
			}
			sections.push(truncateToTokenBudget(histLines.join("\n"), 800));
		}

		// 7. Other pets' status
		if (statusSection) {
			sections.push(truncateToTokenBudget(statusSection, 400));
		}

		// 8. Meta instructions
		sections.push(buildMetaInstructions());

		// 9. Fading knowledge review prompt (only when there is a query — avoids
		//    unnecessary I/O on system-prompt-only builds with no user message)
		if (recentQuery) {
			const reviewSection = await this.toReviewPromptSection();
			if (reviewSection) {
				sections.push(reviewSection);
			}
		}

		return sections.join("\n\n");
	}

	/**
	 * Build a prompt section that reminds the pet about fading memories.
	 * Budget: 400 tokens. The pet can naturally mention these to reinforce them.
	 */
	async toReviewPromptSection(): Promise<string | null> {
		const fading = await this.deps.knowledge.listFading(3);
		if (fading.length === 0) return null;

		const lines = ["# 잊혀져가는 기억 (자연스럽게 언급하면 기억이 강화돼요)"];
		for (const entry of fading) {
			const pct = Math.round(entry.strength * 100);
			lines.push(`- [${entry.topic}] ${entry.content} (강도: ${pct}%)`);
		}

		return truncateToTokenBudget(lines.join("\n"), TOKEN_BUDGETS.review);
	}
}

function buildMetaInstructions(): string {
	return [
		"# 행동 지침",
		"- 사용자가 무언가를 가르치면, 그것을 기억하겠다고 확인해줘",
		"- 이전 대화에서 배운 것이 있으면 자연스럽게 활용해",
		"- 모르는 것은 솔직하게 모른다고 말해",
		"- 도구를 사용할 때는 뭘 할 건지 설명하는 텍스트와 도구 호출을 **같은 응답에서 함께** 보내라. 절대 설명만 하고 멈추지 마라.",
		`- 현재 시각: ${new Date().toLocaleString("ko-KR")}`,
	].join("\n");
}

const BACK_REFERENCE_PATTERNS = [
	/아까/,
	/그거/,
	/그때/,
	/전에/,
	/earlier/i,
	/before/i,
	/지난번/,
	/아까\s*그/,
	/이전에/,
	/방금/,
	/저번/,
	/뭐라고\s*했/,
	/뭐였/,
];

function hasBackReference(text: string): boolean {
	return BACK_REFERENCE_PATTERNS.some((p) => p.test(text));
}

function extractReferenceKeyword(text: string): string {
	// Strip the reference words themselves, keep the subject
	let cleaned = text;
	for (const p of BACK_REFERENCE_PATTERNS) {
		cleaned = cleaned.replace(p, "");
	}
	cleaned = cleaned.replace(/[?？!！.。,，\s]+/g, " ").trim();
	return cleaned || text;
}
