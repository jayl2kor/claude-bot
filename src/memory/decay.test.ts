/**
 * Tests for decay.ts — Ebbinghaus forgetting curve pure functions.
 * Covers: decay formula, reinforcement, clamping, and boundary conditions.
 */

import { describe, expect, it } from "vitest";
import {
	ARCHIVE_THRESHOLD,
	DECAY_LAMBDA,
	DEPRIORITIZE_THRESHOLD,
	REINFORCE_DELTA,
	computeDecayedStrength,
	computeReinforcedStrength,
} from "./decay.js";

describe("computeDecayedStrength", () => {
	it("returns base strength when elapsed hours is 0", () => {
		const result = computeDecayedStrength(1.0, 0);
		expect(result).toBeCloseTo(1.0, 5);
	});

	it("returns base strength when elapsed hours is negative (future)", () => {
		const result = computeDecayedStrength(1.0, -10);
		// Negative time should be treated as 0 (no decay)
		expect(result).toBeCloseTo(1.0, 5);
	});

	it("decays to ~50% at half-life (~35 hours)", () => {
		const halfLife = Math.LN2 / DECAY_LAMBDA; // ~34.66 hours
		const result = computeDecayedStrength(1.0, halfLife);
		expect(result).toBeCloseTo(0.5, 1);
	});

	it("applies correct exponential decay formula", () => {
		// strength(t) = base * e^(-lambda * t)
		const base = 0.8;
		const hours = 10;
		const expected = base * Math.exp(-DECAY_LAMBDA * hours);
		const result = computeDecayedStrength(base, hours);
		expect(result).toBeCloseTo(expected, 5);
	});

	it("decays below deprioritize threshold after sufficient time", () => {
		// For base=1.0, find t where e^(-0.02*t) < 0.3
		// t > -ln(0.3)/0.02 ≈ 60.2 hours
		const result = computeDecayedStrength(1.0, 65);
		expect(result).toBeLessThan(DEPRIORITIZE_THRESHOLD);
	});

	it("decays below archive threshold after extended time", () => {
		// For base=1.0, find t where e^(-0.02*t) < 0.1
		// t > -ln(0.1)/0.02 ≈ 115.1 hours
		const result = computeDecayedStrength(1.0, 120);
		expect(result).toBeLessThan(ARCHIVE_THRESHOLD);
	});

	it("never returns negative values", () => {
		const result = computeDecayedStrength(1.0, 10000);
		expect(result).toBeGreaterThanOrEqual(0);
	});

	it("returns 0 when base strength is 0", () => {
		const result = computeDecayedStrength(0, 10);
		expect(result).toBe(0);
	});

	it("handles fractional base strength", () => {
		const base = 0.5;
		const hours = 20;
		const expected = base * Math.exp(-DECAY_LAMBDA * hours);
		const result = computeDecayedStrength(base, hours);
		expect(result).toBeCloseTo(expected, 5);
	});
});

describe("computeReinforcedStrength", () => {
	it("adds REINFORCE_DELTA to current strength", () => {
		const result = computeReinforcedStrength(0.5);
		expect(result).toBeCloseTo(0.5 + REINFORCE_DELTA, 5);
	});

	it("clamps to 1.0 when reinforcement exceeds max", () => {
		const result = computeReinforcedStrength(0.95);
		expect(result).toBe(1.0);
	});

	it("clamps to 1.0 when already at max", () => {
		const result = computeReinforcedStrength(1.0);
		expect(result).toBe(1.0);
	});

	it("works from 0 strength", () => {
		const result = computeReinforcedStrength(0);
		expect(result).toBeCloseTo(REINFORCE_DELTA, 5);
	});

	it("respects custom delta", () => {
		const result = computeReinforcedStrength(0.5, 0.3);
		expect(result).toBeCloseTo(0.8, 5);
	});

	it("clamps with custom delta", () => {
		const result = computeReinforcedStrength(0.9, 0.5);
		expect(result).toBe(1.0);
	});
});

describe("constants", () => {
	it("DECAY_LAMBDA is 0.02", () => {
		expect(DECAY_LAMBDA).toBe(0.02);
	});

	it("REINFORCE_DELTA is 0.15", () => {
		expect(REINFORCE_DELTA).toBe(0.15);
	});

	it("DEPRIORITIZE_THRESHOLD is 0.3", () => {
		expect(DEPRIORITIZE_THRESHOLD).toBe(0.3);
	});

	it("ARCHIVE_THRESHOLD is 0.1", () => {
		expect(ARCHIVE_THRESHOLD).toBe(0.1);
	});

	it("half-life is approximately 35 hours", () => {
		const halfLife = Math.LN2 / DECAY_LAMBDA;
		expect(halfLife).toBeCloseTo(34.66, 0);
	});
});
