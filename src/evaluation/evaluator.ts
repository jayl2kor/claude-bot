/**
 * PeerEvaluator — polls for pending evaluation requests and evaluates them
 * using Claude haiku.
 *
 * Processes up to 3 pending requests per run to control API costs.
 */

import { spawnClaude } from "../executor/spawner.js";
import { logger } from "../utils/logger.js";
import { EvaluationStore, type EvaluationResult } from "./store.js";

const MAX_EVALUATIONS_PER_RUN = 3;

export class PeerEvaluator {
	constructor(
		private readonly petId: string,
		private readonly store: EvaluationStore,
		private readonly model: string = "haiku",
	) {}

	/**
	 * Find pending evaluation requests and evaluate them with Claude haiku.
	 * Processes at most MAX_EVALUATIONS_PER_RUN requests per invocation.
	 */
	async evaluatePending(): Promise<void> {
		let pending;
		try {
			pending = await this.store.listPending(this.petId);
		} catch (err) {
			logger.warn("PeerEvaluator: failed to list pending", {
				error: String(err),
			});
			return;
		}

		if (pending.length === 0) {
			logger.debug("PeerEvaluator: no pending evaluations");
			return;
		}

		const batch = pending.slice(0, MAX_EVALUATIONS_PER_RUN);
		logger.info("PeerEvaluator: evaluating batch", {
			total: pending.length,
			batch: batch.length,
		});

		for (const req of batch) {
			await this.evaluate(req.id, req.petId, req.promptSummary, req.responseSummary);
		}

		// Run cleanup after evaluating
		try {
			await this.store.cleanup();
		} catch (err) {
			logger.warn("PeerEvaluator: cleanup failed", { error: String(err) });
		}
	}

	private async evaluate(
		requestId: string,
		requesterPetId: string,
		promptSummary: string,
		responseSummary: string,
	): Promise<void> {
		const prompt = [
			"당신은 AI 어시스턴트의 응답 품질을 평가하는 전문 리뷰어입니다.",
			"아래는 한 AI 펫(pet)의 대화 요약입니다. 객관적으로 평가해주세요.",
			"",
			`요청한 펫: ${requesterPetId}`,
			"",
			"=== 사용자 요청 요약 ===",
			promptSummary,
			"",
			"=== AI 응답 요약 ===",
			responseSummary,
			"",
			"아래 JSON 형식으로만 응답해주세요 (다른 텍스트 없이):",
			'{"score": 7, "feedback": "전반적인 평가", "strengths": ["강점1", "강점2"], "improvements": ["개선점1"]}',
			"",
			"- score: 1-10 정수 (10이 최고)",
			"- feedback: 전반적인 피드백 (한국어, 200자 이내)",
			"- strengths: 잘한 점 목록 (최대 3개)",
			"- improvements: 개선할 점 목록 (최대 3개)",
		].join("\n");

		try {
			const handle = spawnClaude({ prompt, model: this.model, maxTurns: 1 });
			let rawResult = "";
			handle.onResult((r) => {
				rawResult = r.result;
			});
			await handle.done;

			if (!rawResult) {
				logger.warn("PeerEvaluator: empty result from haiku", { requestId });
				return;
			}

			const parsed = this.parseResult(rawResult);
			if (!parsed) {
				logger.warn("PeerEvaluator: failed to parse haiku result", {
					requestId,
					rawResult: rawResult.slice(0, 200),
				});
				return;
			}

			const result: EvaluationResult = {
				id: requestId,
				evaluatorId: this.petId,
				score: parsed.score,
				feedback: parsed.feedback,
				strengths: parsed.strengths,
				improvements: parsed.improvements,
				evaluatedAt: Date.now(),
			};

			await this.store.saveResult(result);
			logger.info("PeerEvaluator: evaluation saved", {
				requestId,
				evaluatorId: this.petId,
				score: result.score,
			});
		} catch (err) {
			logger.warn("PeerEvaluator: evaluation failed", {
				requestId,
				error: String(err),
			});
		}
	}

	private parseResult(
		raw: string,
	): { score: number; feedback: string; strengths: string[]; improvements: string[] } | null {
		const match = raw.match(/\{[\s\S]*\}/);
		if (!match) return null;

		try {
			const parsed = JSON.parse(match[0]) as {
				score?: unknown;
				feedback?: unknown;
				strengths?: unknown;
				improvements?: unknown;
			};

			const score = Number(parsed.score);
			if (!Number.isInteger(score) || score < 1 || score > 10) return null;

			const feedback = typeof parsed.feedback === "string" ? parsed.feedback : "";
			const strengths = Array.isArray(parsed.strengths)
				? (parsed.strengths as unknown[]).filter((s): s is string => typeof s === "string")
				: [];
			const improvements = Array.isArray(parsed.improvements)
				? (parsed.improvements as unknown[]).filter(
						(s): s is string => typeof s === "string",
					)
				: [];

			return { score, feedback, strengths, improvements };
		} catch {
			return null;
		}
	}
}
