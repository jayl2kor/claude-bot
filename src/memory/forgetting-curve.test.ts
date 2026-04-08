/**
 * Tests for forgetting curve — Ebbinghaus memory decay model.
 *
 * TDD: Tests written first (RED), implementation follows (GREEN).
 *
 * Design based on Issue #10:
 * - strength(t) = base_strength × e^(-λt)
 * - λ = 0.02, t = hours elapsed since last reference
 * - New knowledge starts at strength = 1.0
 * - Reviewing (reinforce) increases strength by 0.15, capped at 1.0
 * - strength <= 0.1 = forgotten (should be archived)
 *
 * Half-life: ~35 hours (ln(2) / 0.02 ≈ 34.66h)
 */

import { describe, expect, it } from "vitest";
import {
	DECAY_LAMBDA,
	FORGETTING_THRESHOLD,
	INITIAL_STRENGTH,
	REINFORCE_INCREMENT,
	computeDecayedStrength,
	computeReinforcedStrength,
	isForgotten,
} from "./forgetting-curve.js";

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe("ForgettingCurve — constants", () => {
	it("INITIAL_STRENGTH is 1.0", () => {
		expect(INITIAL_STRENGTH).toBe(1.0);
	});

	it("FORGETTING_THRESHOLD is 0.1", () => {
		expect(FORGETTING_THRESHOLD).toBe(0.1);
	});

	it("DECAY_LAMBDA is 0.02", () => {
		expect(DECAY_LAMBDA).toBe(0.02);
	});

	it("REINFORCE_INCREMENT is exactly 0.15", () => {
		expect(REINFORCE_INCREMENT).toBe(0.15);
	});
});

// ---------------------------------------------------------------------------
// computeDecayedStrength — Ebbinghaus decay formula
// ---------------------------------------------------------------------------

describe("computeDecayedStrength", () => {
	it("returns INITIAL_STRENGTH when no time has elapsed (t=0)", () => {
		const result = computeDecayedStrength(INITIAL_STRENGTH, 0);
		expect(result).toBeCloseTo(INITIAL_STRENGTH, 5);
	});

	it("decreases strength as time passes", () => {
		const strength6h = computeDecayedStrength(INITIAL_STRENGTH, 6);
		const strength24h = computeDecayedStrength(INITIAL_STRENGTH, 24);
		const strength72h = computeDecayedStrength(INITIAL_STRENGTH, 72);

		expect(strength6h).toBeLessThan(INITIAL_STRENGTH);
		expect(strength24h).toBeLessThan(strength6h);
		expect(strength72h).toBeLessThan(strength24h);
	});

	it("matches Ebbinghaus formula: strength = base × e^(-λt) at 6 hours", () => {
		const base = 1.0;
		const t = 6; // hours
		const expected = base * Math.exp(-DECAY_LAMBDA * t);
		const result = computeDecayedStrength(base, t);
		expect(result).toBeCloseTo(expected, 10);
	});

	it("matches Ebbinghaus formula at 24 hours", () => {
		const base = 1.0;
		const t = 24;
		const expected = base * Math.exp(-DECAY_LAMBDA * t);
		const result = computeDecayedStrength(base, t);
		expect(result).toBeCloseTo(expected, 10);
	});

	it("matches Ebbinghaus formula at 72 hours (approx 0.237)", () => {
		const result = computeDecayedStrength(1.0, 72);
		// e^(-0.02 * 72) = e^(-1.44) ≈ 0.2369
		expect(result).toBeCloseTo(0.2369, 3);
	});

	it("matches Ebbinghaus formula at 120 hours (approx 0.091)", () => {
		const result = computeDecayedStrength(1.0, 120);
		// e^(-0.02 * 120) = e^(-2.4) ≈ 0.0907
		expect(result).toBeCloseTo(0.0907, 3);
	});

	it("applies decay proportionally to base strength", () => {
		const base = 0.5;
		const t = 24;
		const expected = base * Math.exp(-DECAY_LAMBDA * t);
		const result = computeDecayedStrength(base, t);
		expect(result).toBeCloseTo(expected, 10);
	});

	it("returns 0 when base strength is 0", () => {
		const result = computeDecayedStrength(0, 100);
		expect(result).toBe(0);
	});

	it("never returns a negative value", () => {
		const result = computeDecayedStrength(0.01, 100_000);
		expect(result).toBeGreaterThanOrEqual(0);
	});

	it("half-life is approximately 34.66 hours (ln(2) / lambda)", () => {
		const halfLife = Math.log(2) / DECAY_LAMBDA; // ≈ 34.66h
		const result = computeDecayedStrength(1.0, halfLife);
		expect(result).toBeCloseTo(0.5, 3);
	});

	it("throws when baseStrength is negative", () => {
		expect(() => computeDecayedStrength(-0.5, 6)).toThrow("baseStrength must be >= 0");
	});

	it("throws when hoursElapsed is negative", () => {
		expect(() => computeDecayedStrength(1.0, -1)).toThrow("hoursElapsed must be >= 0");
	});
});

// ---------------------------------------------------------------------------
// computeReinforcedStrength — review / spaced repetition
// ---------------------------------------------------------------------------

describe("computeReinforcedStrength", () => {
	it("increases strength by REINFORCE_INCREMENT", () => {
		const initial = 0.5;
		const result = computeReinforcedStrength(initial);
		expect(result).toBeCloseTo(initial + REINFORCE_INCREMENT, 5);
	});

	it("caps strength at 1.0 (cannot exceed maximum)", () => {
		const nearMax = 0.99;
		const result = computeReinforcedStrength(nearMax);
		expect(result).toBeLessThanOrEqual(1.0);
	});

	it("returns exactly 1.0 when reinforcing from 1.0", () => {
		const result = computeReinforcedStrength(1.0);
		expect(result).toBe(1.0);
	});

	it("caps when increment would push above 1.0", () => {
		const current = 1.0 - REINFORCE_INCREMENT / 2; // just above threshold
		const result = computeReinforcedStrength(current);
		expect(result).toBe(1.0);
	});

	it("can recover a forgotten knowledge back above threshold", () => {
		// Start at a very low strength (below threshold)
		const faded = 0.05;
		const reinforced = computeReinforcedStrength(faded);
		// After one reinforcement, should be above forgetting threshold
		expect(reinforced).toBeGreaterThan(FORGETTING_THRESHOLD);
	});

	it("increases strength from 0.0 to at least REINFORCE_INCREMENT", () => {
		const result = computeReinforcedStrength(0.0);
		expect(result).toBeCloseTo(REINFORCE_INCREMENT, 5);
	});

	it("repeated reinforcements eventually reach 1.0", () => {
		let strength = 0.0;
		for (let i = 0; i < 100; i++) {
			strength = computeReinforcedStrength(strength);
		}
		expect(strength).toBe(1.0);
	});

	it("throws when currentStrength is negative", () => {
		expect(() => computeReinforcedStrength(-0.1)).toThrow("currentStrength must be >= 0");
	});
});

// ---------------------------------------------------------------------------
// isForgotten — threshold check
// ---------------------------------------------------------------------------

describe("isForgotten", () => {
	it("returns true when strength is exactly at FORGETTING_THRESHOLD", () => {
		expect(isForgotten(FORGETTING_THRESHOLD)).toBe(true);
	});

	it("returns true when strength is below FORGETTING_THRESHOLD", () => {
		expect(isForgotten(0.05)).toBe(true);
		expect(isForgotten(0.0)).toBe(true);
		expect(isForgotten(0.09)).toBe(true);
	});

	it("returns false when strength is above FORGETTING_THRESHOLD", () => {
		expect(isForgotten(0.11)).toBe(false);
		expect(isForgotten(0.5)).toBe(false);
		expect(isForgotten(1.0)).toBe(false);
	});

	it("returns false for INITIAL_STRENGTH", () => {
		expect(isForgotten(INITIAL_STRENGTH)).toBe(false);
	});

	it("returns true for strength decayed below threshold at 120h", () => {
		const decayed = computeDecayedStrength(INITIAL_STRENGTH, 120);
		// After 120h: ~0.091 which is just below 0.1
		expect(isForgotten(decayed)).toBe(true);
	});

	it("returns false for strength decayed but still above threshold at 72h", () => {
		const decayed = computeDecayedStrength(INITIAL_STRENGTH, 72);
		// After 72h: ~0.237 which is above 0.1
		expect(isForgotten(decayed)).toBe(false);
	});

	it("throws when strength is negative", () => {
		expect(() => isForgotten(-0.1)).toThrow("strength must be >= 0");
	});
});

// ---------------------------------------------------------------------------
// Integration: full lifecycle (create → decay → reinforce → decay again)
// ---------------------------------------------------------------------------

describe("ForgettingCurve — full lifecycle integration", () => {
	it("new knowledge starts at INITIAL_STRENGTH = 1.0", () => {
		const newStrength = INITIAL_STRENGTH;
		expect(newStrength).toBe(1.0);
		expect(isForgotten(newStrength)).toBe(false);
	});

	it("strength decays over time but reviewing restores it", () => {
		// After 48h without review: e^(-0.02 * 48) ≈ 0.382
		const decayed48h = computeDecayedStrength(INITIAL_STRENGTH, 48);
		expect(decayed48h).toBeCloseTo(0.382, 2);
		expect(isForgotten(decayed48h)).toBe(false); // still above threshold

		// Reinforce (review) at this point
		const afterReview = computeReinforcedStrength(decayed48h);
		expect(afterReview).toBeGreaterThan(decayed48h);
		expect(isForgotten(afterReview)).toBe(false);
	});

	it("without reviews, knowledge eventually falls below forgetting threshold", () => {
		// 120h+ without review pushes below 0.1
		const t = 120;
		const decayed = computeDecayedStrength(INITIAL_STRENGTH, t);
		expect(isForgotten(decayed)).toBe(true);
	});

	it("decay → reinforce cycle shows non-linear recovery", () => {
		// Decay for 72h (strength ≈ 0.237)
		const afterDecay = computeDecayedStrength(INITIAL_STRENGTH, 72);

		// Review once
		const afterReview = computeReinforcedStrength(afterDecay);
		expect(afterReview).toBeGreaterThan(afterDecay);
		expect(afterReview).toBeLessThanOrEqual(1.0);

		// Then decay again for another 72h
		const afterSecondDecay = computeDecayedStrength(afterReview, 72);
		// After reinforcement and second decay, should follow formula
		const expected = afterReview * Math.exp(-DECAY_LAMBDA * 72);
		expect(afterSecondDecay).toBeCloseTo(expected, 5);
	});

	it("knowledge with higher initial strength lasts longer above threshold", () => {
		// Find time at which strength drops to threshold
		// For base=1.0: threshold at t = -ln(0.1) / 0.02 = 115.1h
		// For base=0.5: threshold at t = -ln(0.1/0.5) / 0.02 = -ln(0.2) / 0.02 = 80.5h
		const t = 100;
		const decayedFromFull = computeDecayedStrength(1.0, t);
		const decayedFromHalf = computeDecayedStrength(0.5, t);

		expect(decayedFromFull).toBeGreaterThan(decayedFromHalf);
	});
});
