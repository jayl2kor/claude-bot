/**
 * PR review cron job — Reboong polls for open PRs and submits line-level reviews.
 * PR response cron job — Coboonge polls for review comments and responds.
 */

import { spawnClaude } from "../executor/spawner.js";
import type { PersonaManager } from "../memory/persona.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { logger } from "../utils/logger.js";

export type PRReviewConfig = {
	enabled: boolean;
	pollIntervalMs: number;
	petId: string;
	persona: PersonaManager;
	plugins: ChannelPlugin[];
	workspacePath?: string;
	model?: string;
};

/**
 * Reboong's PR review job: find open PRs, review each with line comments.
 */
export async function runPRReview(config: PRReviewConfig): Promise<void> {
	if (!config.workspacePath) {
		logger.debug("PR review skipped: no workspace path");
		return;
	}

	const persona = await config.persona.getPersona();
	const prompt = [
		`너는 "${persona.name}"이다. 코드 리뷰 전문가.`,
		"",
		"아래 단계를 수행해:",
		"1. gh pr list --state open --json number,title,author,headRefName 실행",
		"2. 내가 아직 리뷰하지 않은 PR을 찾아 (gh api repos/{owner}/{repo}/pulls/{pr}/reviews 로 확인)",
		"3. 각 PR에 대해:",
		"   a. gh pr diff {number} 로 diff 확인",
		"   b. 연결된 이슈 본문 확인",
		"   c. 줄별 리뷰 코멘트 작성 (severity: CRITICAL/HIGH/MEDIUM/LOW)",
		"   d. 모든 코멘트에 '🐰 Reboong:' 접두사 필수",
		"   e. gh api로 줄별 리뷰 제출",
		"4. CRITICAL/HIGH 이슈가 없고 의존 PR이 모두 머지됐고 conflict 없으면 gh pr merge --squash --delete-branch",
		"5. conflict가 있으면 @Coboonge 멘션하며 고치라고 알림",
		"",
		"리뷰할 PR이 없으면 아무것도 하지 마.",
	].join("\n");

	try {
		const handle = spawnClaude({
			prompt,
			model: config.model ?? "sonnet",
			maxTurns: 15,
			cwd: config.workspacePath,
			skipPermissions: true,
		});

		let result = "";
		handle.onResult((r) => {
			result = r.text;
		});
		await handle.done;

		if (result && result.trim()) {
			logger.info("PR review completed", {
				petId: config.petId,
				resultLength: result.length,
			});
		}
	} catch (err) {
		logger.error("PR review cron failed", {
			error: String(err),
			petId: config.petId,
		});
	}
}

/**
 * Coboonge's PR response job: check reviews on my PRs and respond.
 */
export async function runPRResponse(config: PRReviewConfig): Promise<void> {
	if (!config.workspacePath) {
		logger.debug("PR response skipped: no workspace path");
		return;
	}

	const persona = await config.persona.getPersona();
	const prompt = [
		`너는 "${persona.name}"이다. 구현 전문가.`,
		"",
		"아래 단계를 수행해:",
		"1. gh pr list --author @me --state open --json number,title 실행",
		"2. 각 PR에 대해 gh api repos/{owner}/{repo}/pulls/{pr}/comments 로 리뷰 코멘트 확인",
		"3. 아직 답글을 달지 않은 코멘트를 찾아서:",
		"   a. 코멘트 내용 분석 (severity 파악)",
		"   b. CRITICAL/HIGH는 코드를 수정하고 커밋한 후 '반영했습니다' 답글",
		"   c. 동의하지 않으면 '**[코붕이 반박]** 이유: ...' 형태로 기술적 근거와 함께 답글",
		"   d. MEDIUM은 가능하면 반영, 아니면 반박",
		"   e. LOW는 판단에 따라 반영 또는 '다음에 반영하겠습니다' 답글",
		"4. 코드를 수정했으면 git add + git commit + git push",
		"",
		"리뷰 코멘트가 없으면 아무것도 하지 마.",
	].join("\n");

	try {
		const handle = spawnClaude({
			prompt,
			model: config.model ?? "sonnet",
			maxTurns: 15,
			cwd: config.workspacePath,
			skipPermissions: true,
		});

		let result = "";
		handle.onResult((r) => {
			result = r.text;
		});
		await handle.done;

		if (result && result.trim()) {
			logger.info("PR response completed", {
				petId: config.petId,
				resultLength: result.length,
			});
		}
	} catch (err) {
		logger.error("PR response cron failed", {
			error: String(err),
			petId: config.petId,
		});
	}
}
