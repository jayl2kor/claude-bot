/**
 * Ebbinghaus forgetting curve — pure decay and reinforcement functions.
 *
 * Formula: strength(t) = base_strength * e^(-lambda * t)
 * where t = hours since last reference, lambda = 0.02
 *
 * Half-life: ~35 hours (ln(2) / 0.02 ≈ 34.66 hours ≈ 1.4 days)
 *
 * Key thresholds:
 *   6h  → ~0.887  (recent memory, strong)
 *   24h → ~0.619  (day-old, still solid)
 *   72h → ~0.237  (deprioritize in prompts, < 0.3)
 *   120h → ~0.091 (forgotten, archive candidate, < 0.1)
 */

/** Decay rate constant (per hour). */
export const DECAY_LAMBDA = 0.02;

/** Strength assigned to newly learned knowledge. */
export const INITIAL_STRENGTH = 1.0;

/** Strength increment per reinforcement (context reference). */
export const REINFORCE_DELTA = 0.15;

/**
 * Alias for REINFORCE_DELTA — used by forgetting-curve consumers.
 * @deprecated Prefer REINFORCE_DELTA.
 */
export const REINFORCE_INCREMENT = REINFORCE_DELTA;

/** Knowledge below this strength is deprioritized in prompts. */
export const DEPRIORITIZE_THRESHOLD = 0.3;

/**
 * Knowledge below this strength is archived to cold storage.
 * Also used as the forgetting threshold (alias: FORGETTING_THRESHOLD).
 */
export const ARCHIVE_THRESHOLD = 0.1;

/** Alias for ARCHIVE_THRESHOLD — memory is considered forgotten below this. */
export const FORGETTING_THRESHOLD = ARCHIVE_THRESHOLD;

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

/**
 * Returns true if the memory strength is at or below the forgetting threshold,
 * meaning the memory should be deprioritized or archived.
 *
 * @param strength - Current memory strength (0 to 1).
 * @returns `true` if the memory is considered forgotten.
 */
export function isForgotten(strength: number): boolean {
	if (strength < 0) throw new Error("strength must be >= 0");
	return strength <= FORGETTING_THRESHOLD;
}
