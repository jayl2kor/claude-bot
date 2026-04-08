/**
 * EvaluationPublisher — publishes peer evaluation requests after session end.
 *
 * With a configurable probability (default 30%), after a session completes,
 * reads the recent chat history and publishes an EvaluationRequest to the
 * shared evaluations directory.
 */

import { randomUUID } from "node:crypto";
import type { ChatHistoryManager } from "../memory/history.js";
import { logger } from "../utils/logger.js";
import { EvaluationStore } from "./store.js";
import type { EvaluationRequest } from "./types.js";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const SUMMARY_MESSAGE_COUNT = 10;

export class EvaluationPublisher {
	private readonly store: EvaluationStore;

	constructor(
		private readonly petId: string,
		sharedDir: string,
		private readonly probability: number = 0.3,
		private readonly maxPendingCount: number = 5,
	) {
		this.store = new EvaluationStore(sharedDir);
	}

	/**
	 * Possibly publish an evaluation request for the completed session.
	 * Skips if:
	 *  - random roll misses the probability threshold
	 *  - pending count for this pet already exceeds maxPendingCount
	 */
	async maybePublish(
		sessionKey: string,
		userId: string,
		channelId: string,
		history: ChatHistoryManager,
	): Promise<void> {
		// Probabilistic gate
		if (Math.random() >= this.probability) {
			logger.debug("EvaluationPublisher: skipped (probability gate)", {
				sessionKey,
			});
			return;
		}

		// Cost control: don't flood the shared dir
		try {
			const pending = await this.store.countPending(this.petId);
			if (pending >= this.maxPendingCount) {
				logger.debug(
					"EvaluationPublisher: skipped (maxPendingCount reached)",
					{ pending, maxPendingCount: this.maxPendingCount },
				);
				return;
			}
		} catch (err) {
			logger.warn("EvaluationPublisher: failed to count pending", {
				error: String(err),
			});
			return;
		}

		// Build a simple text summary from recent history
		let promptSummary = "";
		let responseSummary = "";
		try {
			const recent = await history.getRecent(channelId, SUMMARY_MESSAGE_COUNT);
			const lines = recent.map((entry) => {
				const role = entry.isBot ? "봇" : "사용자";
				return `${role}: ${entry.content.slice(0, 200)}`;
			});
			const combined = lines.join(" / ");

			// Split into user lines and bot lines for separate summaries
			const userLines = recent
				.filter((e) => !e.isBot)
				.map((e) => e.content.slice(0, 200))
				.join(" / ");
			const botLines = recent
				.filter((e) => e.isBot)
				.map((e) => e.content.slice(0, 200))
				.join(" / ");

			promptSummary = userLines.slice(0, 2000) || combined.slice(0, 2000);
			responseSummary = botLines.slice(0, 2000) || combined.slice(0, 2000);
		} catch (err) {
			logger.warn("EvaluationPublisher: failed to build summary", {
				error: String(err),
			});
			return;
		}

		if (!promptSummary && !responseSummary) {
			logger.debug("EvaluationPublisher: skipped (empty history)", {
				sessionKey,
			});
			return;
		}

		const now = Date.now();
		const req: EvaluationRequest = {
			id: randomUUID(),
			petId: this.petId,
			channelId,
			userId,
			promptSummary,
			responseSummary,
			timestamp: now,
			status: "pending",
			expiresAt: now + TWENTY_FOUR_HOURS,
		};

		try {
			await this.store.create(req);
			logger.info("EvaluationPublisher: published evaluation request", {
				id: req.id,
				petId: this.petId,
				sessionKey,
			});
		} catch (err) {
			logger.warn("EvaluationPublisher: failed to publish", {
				error: String(err),
			});
		}
	}
}
