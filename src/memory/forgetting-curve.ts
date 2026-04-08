/**
 * Forgetting curve — Ebbinghaus memory decay model.
 *
 * Implements the decay formula:
 *   strength(t) = base_strength × e^(-λt)
 *
 * where:
 *   λ (lambda) = 0.02 — decay rate constant
 *   t           = hours elapsed since last reference
 *
 * Half-life: ln(2) / λ ≈ 34.66 hours
 *
 * Key thresholds:
 *   6h  → ~0.887  (recent memory, strong)
 *   24h → ~0.619  (day-old, still solid)
 *   72h → ~0.237  (deprioritize in prompts, < 0.3)
 *   120h → ~0.091 (forgotten, archive candidate, < 0.1)
 *
 * Reference: Issue #10 — 망각 곡선 (Forgetting Curve)
 */

/** Decay rate constant (λ). Higher values = faster forgetting. */
export const DECAY_LAMBDA = 0.02;

/** Strength assigned to newly learned knowledge. */
export const INITIAL_STRENGTH = 1.0;

/** Strength increment applied when knowledge is reinforced (reviewed). */
export const REINFORCE_INCREMENT = 0.15;

/**
 * Strength at or below which knowledge is considered forgotten
 * and becomes an archive candidate.
 */
export const FORGETTING_THRESHOLD = 0.1;

/**
 * Compute the decayed strength of a memory after `hoursElapsed` hours.
 *
 * Formula: decayed = baseStrength × e^(-DECAY_LAMBDA × hoursElapsed)
 *
 * @param baseStrength  - Current strength before decay (0 to 1).
 * @param hoursElapsed  - Hours since last reference.
 * @returns Decayed strength value (>= 0).
 */
export function computeDecayedStrength(
	baseStrength: number,
	hoursElapsed: number,
): number {
	if (baseStrength < 0) throw new Error("baseStrength must be >= 0");
	if (hoursElapsed < 0) throw new Error("hoursElapsed must be >= 0");
	return baseStrength * Math.exp(-DECAY_LAMBDA * hoursElapsed);
}

/**
 * Compute the reinforced strength after a review / reference event.
 *
 * Increases strength by REINFORCE_INCREMENT, capped at 1.0 (maximum strength).
 *
 * @param currentStrength - Current strength before reinforcement (0 to 1).
 * @returns Reinforced strength value, clamped to [0, 1].
 */
export function computeReinforcedStrength(currentStrength: number): number {
	if (currentStrength < 0) throw new Error("currentStrength must be >= 0");
	return Math.min(1.0, currentStrength + REINFORCE_INCREMENT);
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
