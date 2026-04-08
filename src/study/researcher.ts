/**
 * Topic researcher — spawns a Claude CLI session to decompose a topic
 * into subtopics, validates results, and stores knowledge.
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "../executor/spawner.js";
import type { KnowledgeEntry, KnowledgeManager } from "../memory/knowledge.js";
import { logger } from "../utils/logger.js";
import type { StudyConfig, StudyResult, Subtopic } from "./types.js";
import { SubtopicSchema } from "./types.js";

/**
 * Build the research prompt for Claude CLI.
 */
export function buildResearchPrompt(
	topic: string,
	maxSubTopics: number,
): string {
	return [
		`주제: "${topic}"`,
		"",
		`위 주제를 최대 ${maxSubTopics}개의 서브토픽으로 나눠서 각각에 대해 핵심 내용을 정리해줘.`,
		"",
		"반드시 아래 JSON 배열 형식으로만 응답해 (다른 텍스트 없이):",
		'[{"topic": "서브토픽 제목", "content": "핵심 내용 설명 (2-3문장)", "tags": ["태그1", "태그2"]}]',
		"",
		"규칙:",
		"- 각 서브토픽은 독립적이고 구체적이어야 함",
		"- content는 핵심 지식을 압축해서 2-3문장으로",
		"- tags는 관련 키워드 2-3개",
		"- JSON 외 다른 텍스트는 절대 출력하지 마",
	].join("\n");
}

/**
 * Parse research result from Claude CLI response.
 * Extracts JSON array from potentially mixed text output.
 */
export function parseResearchResult(
	text: string,
	maxSubTopics = 8,
): Subtopic[] {
	if (!text.trim()) return [];

	// Try to find JSON array or object in the text
	let jsonStr = "";

	// Try: extract from markdown code block
	const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch?.[1]) {
		jsonStr = codeBlockMatch[1].trim();
	}

	// Try: find a JSON array directly
	if (!jsonStr) {
		const arrayMatch = text.match(/\[[\s\S]*\]/);
		if (arrayMatch) {
			jsonStr = arrayMatch[0];
		}
	}

	// Try: find a JSON object with subtopics key
	if (!jsonStr) {
		const objMatch = text.match(/\{[\s\S]*\}/);
		if (objMatch) {
			jsonStr = objMatch[0];
		}
	}

	if (!jsonStr) return [];

	try {
		const parsed: unknown = JSON.parse(jsonStr);

		// Handle { subtopics: [...] } wrapper
		let items: unknown[];
		if (Array.isArray(parsed)) {
			items = parsed;
		} else if (
			parsed &&
			typeof parsed === "object" &&
			"subtopics" in parsed &&
			Array.isArray((parsed as { subtopics: unknown[] }).subtopics)
		) {
			items = (parsed as { subtopics: unknown[] }).subtopics;
		} else {
			return [];
		}

		// Validate each item with Zod, filter invalid ones
		const validated: Subtopic[] = [];
		for (const item of items) {
			const result = SubtopicSchema.safeParse(item);
			if (result.success && result.data.topic) {
				validated.push(result.data);
			}
			if (validated.length >= maxSubTopics) break;
		}

		return validated;
	} catch {
		logger.warn("Failed to parse research result JSON", {
			textLength: text.length,
		});
		return [];
	}
}

/**
 * Filter out subtopics that already exist in knowledge base (case-insensitive).
 */
export function checkDuplicates(
	subtopics: readonly Subtopic[],
	existingKnowledge: readonly KnowledgeEntry[],
): Subtopic[] {
	const existingTopics = new Set(
		existingKnowledge.map((k) => k.topic.toLowerCase().trim()),
	);

	return subtopics.filter(
		(s) => !existingTopics.has(s.topic.toLowerCase().trim()),
	);
}

/**
 * TopicResearcher — orchestrates the research pipeline.
 */
export class TopicResearcher {
	constructor(
		private readonly config: StudyConfig,
		private readonly knowledge: KnowledgeManager,
	) {}

	/**
	 * Research a topic by spawning a Claude CLI session.
	 * Returns the study result with stored knowledge IDs.
	 */
	async research(topic: string): Promise<StudyResult> {
		const prompt = buildResearchPrompt(topic, this.config.maxSubTopics);

		logger.info("Starting topic research", {
			topic,
			model: this.config.model,
		});

		const handle = spawnClaude({
			prompt,
			model: this.config.model,
			maxTurns: this.config.maxTurns,
		});

		let resultText = "";
		handle.onResult((r) => {
			resultText = r.result;
		});

		const status = await handle.done;

		if (status !== "completed" || !resultText) {
			throw new Error(
				`Research session failed: status=${status}, hasResult=${Boolean(resultText)}`,
			);
		}

		// Parse and validate subtopics
		const subtopics = parseResearchResult(resultText, this.config.maxSubTopics);
		if (subtopics.length === 0) {
			throw new Error("No valid subtopics found in research result");
		}

		// Dedup against existing knowledge
		const existing = await this.knowledge.listAll();
		const newSubtopics = checkDuplicates(subtopics, existing);

		// Store new knowledge entries
		const knowledgeIds: string[] = [];
		const now = Date.now();

		for (const subtopic of newSubtopics) {
			const id = `study-${randomUUID()}`;
			await this.knowledge.upsert({
				id,
				topic: subtopic.topic,
				content: subtopic.content,
				source: "self-studied",
				createdAt: now,
				confidence: 0.7,
				tags: subtopic.tags,
			});
			knowledgeIds.push(id);
		}

		logger.info("Topic research completed", {
			topic,
			totalSubtopics: subtopics.length,
			newSubtopics: newSubtopics.length,
			duplicatesSkipped: subtopics.length - newSubtopics.length,
		});

		return {
			subtopics: newSubtopics,
			knowledgeIds,
		};
	}
}
