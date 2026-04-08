/**
 * Session-end integrator — runs after each session to:
 * 1. Use LLM to extract any long-term learnings from the conversation
 * 2. Generate a session reflection
 * 3. Update relationship notes
 *
 * Reference: OpenClaw memory-core dreaming pattern (extraction → consolidation → narrative)
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "../executor/spawner.js";
import type { FeedPublisher } from "../knowledge-feed/publisher.js";
import type { KnowledgeEntry, KnowledgeManager } from "../memory/knowledge.js";
import type { Reflection } from "../memory/reflection.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import { logger } from "../utils/logger.js";

export type IntegrationResult = {
	reflection: Reflection | null;
	knowledgeStored: number;
	notesAdded: number;
};

type LLMExtractedItem = {
	type: "fact" | "preference" | "correction" | "instruction";
	content: string;
	topic: string;
};

export class SessionIntegrator {
	constructor(
		private readonly knowledge: KnowledgeManager,
		private readonly reflections: ReflectionManager,
		private readonly relationships: RelationshipManager,
		private readonly feedPublisher?: FeedPublisher,
	) {}

	/**
	 * Process a completed session. Should be called after session ends.
	 * Runs LLM-based extraction on ALL conversations — no regex gating.
	 * This is fire-and-forget — failures are logged but don't propagate.
	 */
	async integrate(
		sessionKey: string,
		userId: string,
		conversationSummary: string,
	): Promise<IntegrationResult> {
		let knowledgeStored = 0;
		let notesAdded = 0;
		let reflection: Reflection | null = null;

		try {
			// 1. Ask LLM to extract long-term learnings from the conversation
			const items = await this.extractLearnings(conversationSummary);
			if (items.length > 0) {
				knowledgeStored = await this.saveLearnings(items, userId);
			}

			// 2. Generate session reflection via Claude
			reflection = await this.generateReflection(
				sessionKey,
				userId,
				conversationSummary,
			);
			if (reflection) {
				await this.reflections.save(reflection);
			}

			// 3. Add relationship note if meaningful interaction
			if (conversationSummary.length > 100) {
				const note = summarizeForRelationship(conversationSummary);
				if (note) {
					await this.relationships.addNote(userId, note);
					notesAdded = 1;
				}
			}

			logger.info("Session integration complete", {
				sessionKey,
				knowledgeStored,
				notesAdded,
				hasReflection: !!reflection,
			});
		} catch (err) {
			logger.error("Session integration failed", {
				sessionKey,
				error: String(err),
			});
		}

		return { reflection, knowledgeStored, notesAdded };
	}

	/**
	 * Use LLM (haiku) to extract long-term learnings from conversation.
	 * Returns empty array if nothing worth remembering.
	 */
	private async extractLearnings(
		conversationSummary: string,
	): Promise<LLMExtractedItem[]> {
		if (conversationSummary.length < 10) return [];

		const prompt = [
			"아래는 사용자와의 대화 내용이야.",
			"이 대화에서 장기적으로 기억해야 할 정보를 추출해줘.",
			"",
			"추출 대상:",
			'- 사실/지식 (예: "나 고양이 알러지 있어")',
			'- 선호도 (예: "커피보다 차를 좋아해")',
			'- 교정 사항 (예: "아까 말한 건 틀렸어, 실제로는...")',
			'- 행동 지침 (예: "앞으로 존댓말로 해줘")',
			"",
			"기억할 게 없으면 빈 배열을 반환해.",
			'JSON으로만 응답: [{"type": "fact|preference|correction|instruction", "content": "...", "topic": "..."}]',
			"",
			"대화 내용:",
			conversationSummary.slice(0, 3000),
		].join("\n");

		try {
			const handle = spawnClaude({
				prompt,
				model: "haiku",
				maxTurns: 1,
				skipPermissions: true,
			});

			let resultText = "";
			handle.onResult((r) => {
				resultText = r.text;
			});

			const status = await handle.done;
			if (status !== "completed" || !resultText) return [];

			// Extract JSON array from response
			const jsonMatch = resultText.match(/\[[\s\S]*\]/);
			if (!jsonMatch) return [];

			const parsed = JSON.parse(jsonMatch[0]) as unknown[];
			if (!Array.isArray(parsed)) return [];

			const items: LLMExtractedItem[] = [];
			for (const item of parsed) {
				if (
					item &&
					typeof item === "object" &&
					"type" in item &&
					"content" in item &&
					"topic" in item &&
					typeof (item as LLMExtractedItem).content === "string" &&
					typeof (item as LLMExtractedItem).topic === "string"
				) {
					const t = (item as LLMExtractedItem).type;
					if (
						t === "fact" ||
						t === "preference" ||
						t === "correction" ||
						t === "instruction"
					) {
						items.push(item as LLMExtractedItem);
					}
				}
			}

			logger.debug("LLM learning extraction complete", {
				extracted: items.length,
			});
			return items;
		} catch (err) {
			logger.warn("LLM learning extraction failed", { error: String(err) });
			return [];
		}
	}

	/**
	 * Save extracted LLM learnings to the knowledge / relationships store.
	 * Returns number of items stored.
	 */
	private async saveLearnings(
		items: LLMExtractedItem[],
		userId: string,
	): Promise<number> {
		let stored = 0;

		for (const item of items) {
			try {
				if (item.type === "preference" || item.type === "instruction") {
					// Route preferences and instructions to relationship manager
					await this.relationships.addPreference(userId, item.content);
					logger.info("Preference/instruction stored via LLM", {
						userId,
						topic: item.topic,
						type: item.type,
					});
					stored++;
					continue;
				}

				// fact / correction → knowledge store
				const source: KnowledgeEntry["source"] =
					item.type === "correction" ? "corrected" : "taught";
				const confidence = item.type === "correction" ? 0.95 : 0.85;

				const now = Date.now();
				const entry: KnowledgeEntry = {
					id: randomUUID(),
					topic: item.topic.slice(0, 50),
					content: item.content,
					source,
					taughtBy: userId,
					createdAt: now,
					updatedAt: now,
					confidence,
					tags: [],
					strength: 1.0,
					lastReferencedAt: now,
					referenceCount: 0,
				};

				await this.knowledge.upsert(entry);
				logger.info("Knowledge stored via LLM", {
					topic: entry.topic,
					id: entry.id,
					source,
				});

				// Publish to shared feed for cross-pet propagation
				if (this.feedPublisher) {
					await this.feedPublisher.publish(entry).catch((err) => {
						logger.warn("Failed to publish knowledge to feed", {
							id: entry.id,
							error: String(err),
						});
					});
				}

				stored++;
			} catch (err) {
				logger.warn("Failed to save learning item", {
					topic: item.topic,
					error: String(err),
				});
			}
		}

		return stored;
	}

	/**
	 * Generate a reflection by asking Claude to summarize the session.
	 * Uses a short, single-turn call with --max-turns 1.
	 */
	private async generateReflection(
		sessionKey: string,
		userId: string,
		conversationSummary: string,
	): Promise<Reflection | null> {
		if (conversationSummary.length < 50) return null;

		const prompt = [
			"다음 대화 내용을 분석해서 JSON으로 응답해줘.",
			"반드시 아래 형식만 출력해 (다른 텍스트 없이):",
			'{"summary": "대화 요약 (2-3문장)", "insights": ["배운 점1", "배운 점2"]}',
			"",
			"대화 내용:",
			conversationSummary.slice(0, 2000),
		].join("\n");

		try {
			const handle = spawnClaude({
				prompt,
				model: "haiku",
				maxTurns: 1,
				skipPermissions: true,
			});

			let resultText = "";
			handle.onResult((r) => {
				resultText = r.text;
			});

			const status = await handle.done;
			if (status !== "completed" || !resultText) return null;

			// Try to parse JSON from response
			const jsonMatch = resultText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return null;

			const parsed = JSON.parse(jsonMatch[0]) as {
				summary?: string;
				insights?: string[];
			};

			if (!parsed.summary) return null;

			return {
				id: randomUUID(),
				sessionKey,
				userId,
				summary: parsed.summary,
				insights: parsed.insights ?? [],
				createdAt: Date.now(),
			};
		} catch (err) {
			logger.warn("Reflection generation failed", { error: String(err) });
			return null;
		}
	}
}

/** Create a short relationship note from conversation. */
function summarizeForRelationship(text: string): string | null {
	// Take first meaningful sentence as a note
	const sentences = text.split(/[.!?。]\s*/);
	const meaningful = sentences.find((s) => s.length > 20 && s.length < 200);
	if (!meaningful) return null;

	const date = new Date().toLocaleDateString("ko-KR");
	return `[${date}] ${meaningful.trim()}`;
}
