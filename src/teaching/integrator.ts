/**
 * Session-end integrator — runs after each session to:
 * 1. Detect any unprocessed teachings from the conversation
 * 2. Generate a session reflection
 * 3. Update relationship notes
 *
 * Reference: OpenClaw memory-core dreaming pattern (extraction → consolidation → narrative)
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "../executor/spawner.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { Reflection } from "../memory/reflection.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import { logger } from "../utils/logger.js";
import { detectTeaching } from "./detector.js";
import { KnowledgeExtractor } from "./extractor.js";

export type IntegrationResult = {
	reflection: Reflection | null;
	knowledgeStored: number;
	notesAdded: number;
};

export class SessionIntegrator {
	private readonly extractor: KnowledgeExtractor;

	constructor(
		knowledge: KnowledgeManager,
		private readonly reflections: ReflectionManager,
		private readonly relationships: RelationshipManager,
	) {
		this.extractor = new KnowledgeExtractor(knowledge, relationships);
	}

	/**
	 * Process a completed session. Should be called after session ends.
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
			// 1. Scan conversation for missed teaching intents
			const intents = detectTeaching(conversationSummary);
			if (intents.length > 0) {
				const result = await this.extractor.extract(intents, userId);
				knowledgeStored = result.stored;
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
			});

			let resultText = "";
			handle.onResult((r) => {
				resultText = r.result;
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
