/**
 * GitReviewer — generates persona-based code reviews via Claude haiku.
 *
 * Constructs a review prompt with persona injection, sends to Claude haiku,
 * and formats the result for channel delivery.
 */

import { spawnClaude } from "../executor/spawner.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { logger } from "../utils/logger.js";
import type { GitCommitInfo } from "./types.js";

export class GitReviewer {
	constructor(
		private readonly petName: string,
		private readonly persona: string,
	) {}

	/** Generate a persona-based code review for a commit. */
	async review(commit: GitCommitInfo, diff: string): Promise<string> {
		const prompt = this.buildPrompt(commit, diff);

		const handle = spawnClaude({ prompt, model: "haiku", maxTurns: 1 });

		let reviewText = "";
		handle.onResult((r) => {
			reviewText = r.text;
		});

		const status = await handle.done;

		if (status !== "completed" || !reviewText) {
			logger.warn("GitReviewer: Claude review failed or empty", {
				sha: commit.shortSha,
				status,
			});
			return this.formatMessage(commit, "(review unavailable)");
		}

		return this.formatMessage(commit, reviewText);
	}

	/** Format the final message for channel delivery. */
	formatMessage(commit: GitCommitInfo, reviewText: string): string {
		return `[GIT] ${commit.shortSha} by ${commit.author}: ${commit.message}\n\n${reviewText}`;
	}

	/** Send a review message to a channel via plugin. */
	async sendReview(
		plugin: ChannelPlugin,
		channelId: string,
		message: string,
	): Promise<void> {
		try {
			await plugin.sendMessage(channelId, message, undefined);
		} catch (err) {
			logger.error("GitReviewer: failed to send review", {
				channelId,
				error: String(err),
			});
		}
	}

	/** Build the review prompt with persona injection. */
	private buildPrompt(commit: GitCommitInfo, diff: string): string {
		return [
			`너는 ${this.petName}이야. 성격: ${this.persona}`,
			"",
			"아래 git commit의 코드 변경사항을 리뷰해줘.",
			"간결하고 핵심적인 리뷰를 해줘 (3-5줄).",
			"좋은 점, 개선할 점, 잠재적 문제를 포함해.",
			"너의 성격에 맞게 리뷰해줘.",
			"",
			`커밋: ${commit.shortSha} by ${commit.author}`,
			`메시지: ${commit.message}`,
			"",
			"--- diff ---",
			diff,
		].join("\n");
	}
}
