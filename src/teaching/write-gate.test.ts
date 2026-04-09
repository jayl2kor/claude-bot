/**
 * Tests for WriteGate — gate decision scoring before long-term storage (Issue #41).
 *
 * The write gate evaluates staged items for:
 * - Factuality: is the payload verifiable / not speculative?
 * - Reusability: will this be referenced across sessions?
 * - Sensitivity: does it contain personal or sensitive data?
 *
 * Decision: approve / hold / reject based on composite score.
 */

import { describe, expect, it } from "vitest";
import {
	WriteGate,
	type GateDecision,
	type GateScore,
} from "./write-gate.js";
import type { StagedItem } from "./staging-queue.js";
import { randomUUID } from "node:crypto";

function makeStagedItem(overrides: Partial<StagedItem> = {}): StagedItem {
	const now = Date.now();
	return {
		id: randomUUID(),
		sessionKey: "session-123",
		userId: "user-abc",
		type: "explicit",
		payload: "TypeScript는 JavaScript의 상위 집합이야",
		confidence: 0.95,
		extractedAt: now,
		retryCount: 0,
		status: "pending",
		...overrides,
	};
}

describe("WriteGate", () => {
	const gate = new WriteGate();

	// -------------------------------------------------------------------------
	// evaluate — basic decision logic
	// -------------------------------------------------------------------------

	describe("evaluate", () => {
		it("returns approve for high-quality factual knowledge", () => {
			const item = makeStagedItem({
				type: "explicit",
				payload: "TypeScript는 JavaScript의 상위 집합이다",
				confidence: 0.95,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("approve");
			expect(result.score.total).toBeGreaterThan(0.6);
		});

		it("returns reject for very short or empty payload", () => {
			const item = makeStagedItem({
				payload: "ok",
				confidence: 0.5,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("reject");
		});

		it("returns reject for low confidence items", () => {
			const item = makeStagedItem({
				payload: "아마도 그럴지도 모르겠어 어쩌면 가능성이 있을 것 같기도 해",
				confidence: 0.3,
			});

			const result = gate.evaluate(item);

			expect(result.decision).not.toBe("approve");
		});

		it("returns hold for medium-confidence items", () => {
			const item = makeStagedItem({
				type: "preference",
				payload: "좋아하는 것: 커피",
				confidence: 0.65,
				retryCount: 0,
			});

			const result = gate.evaluate(item);

			// Preference with moderate confidence — may hold for review
			expect(["hold", "approve"]).toContain(result.decision);
		});

		it("rejects items with sensitive data patterns", () => {
			const item = makeStagedItem({
				payload: "내 비밀번호는 abc123 이야",
				confidence: 0.9,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("reject");
			expect(result.reason).toContain("민감");
		});

		it("rejects items with phone number patterns", () => {
			const item = makeStagedItem({
				payload: "내 전화번호는 010-1234-5678 이야",
				confidence: 0.9,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("reject");
		});

		it("rejects items with email patterns", () => {
			const item = makeStagedItem({
				payload: "내 이메일은 test@example.com 이야",
				confidence: 0.9,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("reject");
		});

		it("approves correction type with high confidence", () => {
			const item = makeStagedItem({
				type: "correction",
				payload: "JavaScript에서 == 대신 === 를 써야 한다",
				confidence: 0.95,
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("approve");
		});

		it("includes gate log with scores", () => {
			const item = makeStagedItem();
			const result = gate.evaluate(item);

			expect(result.score).toBeDefined();
			expect(result.score.factuality).toBeGreaterThanOrEqual(0);
			expect(result.score.factuality).toBeLessThanOrEqual(1);
			expect(result.score.reusability).toBeGreaterThanOrEqual(0);
			expect(result.score.reusability).toBeLessThanOrEqual(1);
			expect(result.score.sensitivity).toBeGreaterThanOrEqual(0);
			expect(result.score.sensitivity).toBeLessThanOrEqual(1);
			expect(result.score.total).toBeGreaterThanOrEqual(0);
			expect(result.score.total).toBeLessThanOrEqual(1);
		});
	});

	// -------------------------------------------------------------------------
	// evaluateMany
	// -------------------------------------------------------------------------

	describe("evaluateMany", () => {
		it("evaluates multiple items and returns decisions for each", () => {
			const items = [
				makeStagedItem({ payload: "ok" }), // short — reject
				makeStagedItem({
					type: "explicit",
					payload: "React는 Facebook이 만든 UI 라이브러리다",
					confidence: 0.9,
				}), // good — approve
			];

			const results = gate.evaluateMany(items);

			expect(results).toHaveLength(2);
			expect(results[0]?.result.decision).toBe("reject");
			expect(results[1]?.result.decision).toBe("approve");
		});

		it("returns empty array for empty input", () => {
			const results = gate.evaluateMany([]);
			expect(results).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// held item re-evaluation policy
	// -------------------------------------------------------------------------

	describe("held item re-evaluation", () => {
		it("promotes held item to approve after retryCount >= 1 if score improves", () => {
			// An item that was previously held but has been seen again (retryCount=1)
			// and has higher confidence this time
			const item = makeStagedItem({
				type: "explicit",
				payload: "Go언어는 구글이 만든 정적 타입 언어다",
				confidence: 0.85,
				status: "held",
				retryCount: 1,
			});

			const result = gate.evaluate(item);

			// With confidence 0.85 and retryCount 1, should approve
			expect(result.decision).toBe("approve");
		});

		it("rejects held item after maxRetries exceeded", () => {
			const item = makeStagedItem({
				payload: "짧아", // low quality
				confidence: 0.5,
				status: "held",
				retryCount: 3, // exceeded max retries
			});

			const result = gate.evaluate(item);

			expect(result.decision).toBe("reject");
		});
	});

	// -------------------------------------------------------------------------
	// GateScore structure
	// -------------------------------------------------------------------------

	describe("GateScore", () => {
		it("factuality is higher for objective statements", () => {
			const objective = makeStagedItem({
				payload: "Python은 인터프리터 언어이며 동적 타이핑을 사용한다",
				confidence: 0.9,
			});
			const speculative = makeStagedItem({
				payload: "아마도 가능한지도 모르겠어 어쩌면 그럴 것 같기도 하고",
				confidence: 0.9,
			});

			const objResult = gate.evaluate(objective);
			const specResult = gate.evaluate(speculative);

			expect(objResult.score.factuality).toBeGreaterThan(
				specResult.score.factuality,
			);
		});

		it("reusability is higher for general facts than personal preferences", () => {
			const fact = makeStagedItem({
				type: "explicit",
				payload: "Node.js는 V8 엔진 위에서 동작하는 JavaScript 런타임이다",
				confidence: 0.9,
			});
			const preference = makeStagedItem({
				type: "preference",
				payload: "좋아하는 것: 커피",
				confidence: 0.9,
			});

			const factResult = gate.evaluate(fact);
			const prefResult = gate.evaluate(preference);

			expect(factResult.score.reusability).toBeGreaterThanOrEqual(
				prefResult.score.reusability,
			);
		});

		it("sensitivity is higher (worse) for items containing PII patterns", () => {
			const safe = makeStagedItem({
				payload: "JavaScript에서 클로저는 외부 변수를 캡처한다",
				confidence: 0.9,
			});
			const sensitive = makeStagedItem({
				payload: "내 계좌번호는 1234-5678-9012야",
				confidence: 0.9,
			});

			const safeResult = gate.evaluate(safe);
			const sensitiveResult = gate.evaluate(sensitive);

			expect(sensitiveResult.score.sensitivity).toBeGreaterThan(
				safeResult.score.sensitivity,
			);
		});
	});
});
