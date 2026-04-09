/**
 * Write gate for the two-stage learning pipeline (Issue #41).
 *
 * Before any item is promoted from the staging queue to long-term knowledge,
 * it passes through this gate. The gate scores each item on three axes:
 *
 * 1. Factuality  — is this an objective, verifiable statement?
 * 2. Reusability — will this be useful across multiple future sessions?
 * 3. Sensitivity — does this contain PII or sensitive personal data?
 *
 * Composite score → decision:
 *   total >= APPROVE_THRESHOLD → approve
 *   total >= HOLD_THRESHOLD    → hold (re-evaluate in next batch)
 *   total <  HOLD_THRESHOLD    → reject
 *
 * Held items are re-evaluated up to MAX_RETRIES times.
 */

import type { StagedItem } from "./staging-queue.js";

export type GateScore = {
	/** 0–1: higher = more factual / objective. */
	factuality: number;
	/** 0–1: higher = more reusable across sessions. */
	reusability: number;
	/** 0–1: higher = more sensitive (bad). Inverted in composite score. */
	sensitivity: number;
	/** Composite score 0–1 used for decision. */
	total: number;
};

export type GateDecision = "approve" | "hold" | "reject";

export type GateResult = {
	decision: GateDecision;
	score: GateScore;
	reason: string;
};

/** Thresholds for gate decisions. */
const APPROVE_THRESHOLD = 0.55;
const HOLD_THRESHOLD = 0.35;
const MAX_RETRIES = 2;

/** Minimum payload length to be considered for approval. */
const MIN_PAYLOAD_LENGTH = 5;

/** Patterns that indicate speculative/uncertain statements. */
const SPECULATIVE_PATTERNS = [
	/아마도/,
	/어쩌면/,
	/혹시/,
	/같기도/,
	/것\s*같/,
	/모르겠/,
	/가능성/,
	/maybe/i,
	/perhaps/i,
	/possibly/i,
	/might be/i,
	/not sure/i,
];

/** Patterns indicating Personally Identifiable Information (PII). */
const PII_PATTERNS = [
	/비밀번호/,
	/password/i,
	/\d{2,3}-\d{3,4}-\d{4}/, // phone numbers
	/\d{6}-\d{7}/, // Korean resident registration
	/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // email
	/계좌\s*번호/,
	/카드\s*번호/,
	/주민\s*등록/,
	/account\s*number/i,
	/credit\s*card/i,
	/social\s*security/i,
];

/** Patterns indicating a general/reusable fact (not personal preference). */
const FACTUAL_KEYWORDS = [
	/이다$|입니다$|이야$|이에요$/m,
	/^[A-Za-z가-힣].+는\s.+이다/m,
	/이란\s/,
	/정의/,
	/설명/,
];

export class WriteGate {
	/**
	 * Evaluate a single staged item and return a gate decision with scores.
	 */
	evaluate(item: StagedItem): GateResult {
		// Hard reject: exceeded max retries
		if (item.retryCount > MAX_RETRIES) {
			return {
				decision: "reject",
				score: zeroScore(),
				reason: `최대 재시도 횟수 초과 (${item.retryCount}/${MAX_RETRIES})`,
			};
		}

		// Hard reject: payload too short
		if (item.payload.trim().length < MIN_PAYLOAD_LENGTH) {
			return {
				decision: "reject",
				score: zeroScore(),
				reason: `페이로드가 너무 짧음 (${item.payload.length} 글자)`,
			};
		}

		const score = computeScore(item);

		// Hard reject: contains sensitive data
		if (score.sensitivity > 0.5) {
			return {
				decision: "reject",
				score,
				reason: "민감한 개인정보 패턴 감지됨",
			};
		}

		if (score.total >= APPROVE_THRESHOLD) {
			return {
				decision: "approve",
				score,
				reason: `점수 통과 (total=${score.total.toFixed(2)})`,
			};
		}

		if (score.total >= HOLD_THRESHOLD) {
			return {
				decision: "hold",
				score,
				reason: `점수 미달, 다음 배치에서 재평가 (total=${score.total.toFixed(2)})`,
			};
		}

		return {
			decision: "reject",
			score,
			reason: `점수 기준 미달 (total=${score.total.toFixed(2)})`,
		};
	}

	/**
	 * Evaluate multiple staged items at once.
	 * Returns an array of { item, result } pairs in the same order.
	 */
	evaluateMany(
		items: StagedItem[],
	): Array<{ item: StagedItem; result: GateResult }> {
		return items.map((item) => ({ item, result: this.evaluate(item) }));
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function zeroScore(): GateScore {
	return { factuality: 0, reusability: 0, sensitivity: 0, total: 0 };
}

/**
 * Compute factuality, reusability, sensitivity scores for an item.
 */
function computeScore(item: StagedItem): GateScore {
	const payload = item.payload;

	// --- Factuality (0-1) ---
	let factuality = item.confidence; // base: detector confidence

	// Penalise speculative language
	const speculativeCount = SPECULATIVE_PATTERNS.filter((p) =>
		p.test(payload),
	).length;
	factuality -= speculativeCount * 0.15;

	// Boost for explicit type (user intentionally taught)
	if (item.type === "explicit" || item.type === "correction") {
		factuality = Math.min(1, factuality + 0.1);
	}

	factuality = Math.max(0, Math.min(1, factuality));

	// --- Reusability (0-1) ---
	let reusability = 0.5; // neutral base

	// Factual assertions are more reusable than preferences
	if (item.type === "preference") {
		reusability -= 0.2;
	}
	if (item.type === "correction") {
		reusability += 0.15;
	}

	// Longer payloads tend to be more specific and reusable
	const length = payload.length;
	if (length > 30) reusability += 0.1;
	if (length > 60) reusability += 0.1;
	if (length > 120) reusability += 0.05;

	// Presence of factual keywords boosts reusability
	const factualHits = FACTUAL_KEYWORDS.filter((p) => p.test(payload)).length;
	reusability += factualHits * 0.05;

	reusability = Math.max(0, Math.min(1, reusability));

	// --- Sensitivity (0-1, higher = more sensitive = worse) ---
	let sensitivity = 0;
	const piiHits = PII_PATTERNS.filter((p) => p.test(payload)).length;
	sensitivity = Math.min(1, piiHits * 0.6);

	// --- Composite score ---
	// Weights: factuality 0.45, reusability 0.35, safety (1-sensitivity) 0.20
	const total =
		factuality * 0.45 +
		reusability * 0.35 +
		(1 - sensitivity) * 0.2;

	return {
		factuality,
		reusability,
		sensitivity,
		total: Math.max(0, Math.min(1, total)),
	};
}
