/**
 * Ebbinghaus forgetting curve — pure decay and reinforcement functions.
 *
 * Formula: strength(t) = base_strength * e^(-lambda * t)
 * where t = hours since last reference, lambda = 0.02
 *
 * Half-life: ~35 hours (ln(2) / 0.02 ≈ 34.66 hours ≈ 1.4 days)
 */

/** Decay rate constant (per hour). */
export const DECAY_LAMBDA = 0.02;

/** Strength increment per reinforcement (context reference). */
export const REINFORCE_DELTA = 0.15;

/** Knowledge below this strength is deprioritized in prompts. */
export const DEPRIORITIZE_THRESHOLD = 0.3;

/** Knowledge below this strength is archived to cold storage. */
export const ARCHIVE_THRESHOLD = 0.1;

/**
 * Compute the decayed strength of a knowledge entry.
 *
 * @param baseStrength - The strength at last reference (0..1)
 * @param elapsedHours - Hours since last reference
 * @returns Decayed strength (always >= 0)
 */
export function computeDecayedStrength(
	baseStrength: number,
	elapsedHours: number,
): number {
	if (baseStrength <= 0) return 0;
	const t = Math.max(0, elapsedHours);
	return baseStrength * Math.exp(-DECAY_LAMBDA * t);
}

/**
 * Compute the reinforced strength after a reference.
 *
 * @param currentStrength - Current strength (0..1)
 * @param delta - Reinforcement increment (default REINFORCE_DELTA)
 * @returns Reinforced strength, clamped to [0, 1]
 */
export function computeReinforcedStrength(
	currentStrength: number,
	delta: number = REINFORCE_DELTA,
): number {
	return Math.min(1.0, currentStrength + delta);
}
