/**
 * Study status checker.
 * Detects when a user is asking about study progress and formats responses.
 */

import type { StudyQueueState } from "./types.js";

/** Patterns that indicate the user is asking about study status. */
const STATUS_CHECK_PATTERNS = [
	/공부\s*다\s*했어/,
	/공부\s*다했어/,
	/공부\s*끝났어/,
	/학습\s*상태/,
	/공부\s*현황/,
	/리서치\s*끝났어/,
	/학습\s*끝났어/,
	/조사\s*끝났어/,
	/^\/study-status$/i,
];

/**
 * Detect if the user is asking about study/learning status.
 */
export function detectStatusCheck(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;

	return STATUS_CHECK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const STATUS_ICONS: Record<string, string> = {
	completed: "[completed]",
	in_progress: "[in_progress]",
	queued: "[queued]",
	failed: "[failed]",
};

/**
 * Format a human-readable status response for the study queue.
 */
export function formatStatusResponse(state: StudyQueueState): string {
	if (state.requests.length === 0) {
		return "학습 대기열이 비어있습니다. 공부할 주제를 알려주세요!";
	}

	const lines: string[] = ["## 학습 현황"];

	for (const req of state.requests) {
		const icon = STATUS_ICONS[req.status] ?? "[?]";
		let line = `${icon} **${req.topic}**`;

		if (req.status === "completed" && req.result) {
			const subtopicCount = req.result.subtopics.length;
			line += ` — ${subtopicCount}개 서브토픽 학습 완료`;
		} else if (req.status === "failed" && req.error) {
			line += ` — 실패: ${req.error}`;
		}

		lines.push(line);
	}

	lines.push("");
	lines.push(`오늘 학습 횟수: ${state.dailyCount}`);

	return lines.join("\n");
}
