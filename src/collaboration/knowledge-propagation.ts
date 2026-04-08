/**
 * Knowledge propagation between pets.
 *
 * Allows one pet to share knowledge entries it has learned with another pet.
 * Only knowledge above a confidence threshold is propagated.
 * Propagated knowledge has its confidence reduced to 80% of the original.
 */

import type { KnowledgeManager } from "../memory/knowledge.js";
import { logger } from "../utils/logger.js";

/** Minimum confidence level required for knowledge to be propagated. */
export const PROPAGATION_CONFIDENCE_THRESHOLD = 0.7;

/** Strength multiplier applied to propagated knowledge. */
export const PROPAGATION_STRENGTH_FACTOR = 0.8;

export type PropagationEvent = {
	sourcePetId: string;
	targetPetId: string;
	knowledgeId: string;
	topic: string;
	originalConfidence: number;
	propagatedConfidence: number;
	propagatedAt: number;
};

export type PropagationResult = {
	propagated: PropagationEvent[];
	skippedLowConfidence: number;
	skippedAlreadyKnown: number;
};

export type KnowledgePropagatorDeps = {
	sourceKnowledge: KnowledgeManager;
	targetKnowledge: KnowledgeManager;
};

/**
 * Propagate knowledge from one pet's knowledge store to another's.
 *
 * Rules:
 * - Only entries with confidence >= PROPAGATION_CONFIDENCE_THRESHOLD are propagated.
 * - Entries that already exist in the target are skipped (no duplicate propagation).
 * - Propagated entries have their confidence multiplied by PROPAGATION_STRENGTH_FACTOR.
 * - Each propagation event is logged.
 */
export async function propagateKnowledge(
	sourcePetId: string,
	targetPetId: string,
	deps: KnowledgePropagatorDeps,
): Promise<PropagationResult> {
	if (!sourcePetId.trim()) throw new Error("sourcePetId must not be empty");
	if (!targetPetId.trim()) throw new Error("targetPetId must not be empty");

	const sourceEntries = await deps.sourceKnowledge.listAll();
	const targetEntries = await deps.targetKnowledge.listAll();
	const targetIds = new Set(targetEntries.map((e) => e.id));

	const propagated: PropagationEvent[] = [];
	let skippedLowConfidence = 0;
	let skippedAlreadyKnown = 0;

	for (const entry of sourceEntries) {
		// Filter: confidence threshold
		if (entry.confidence < PROPAGATION_CONFIDENCE_THRESHOLD) {
			skippedLowConfidence++;
			continue;
		}

		// Filter: already known by target
		if (targetIds.has(entry.id)) {
			skippedAlreadyKnown++;
			continue;
		}

		// Compute propagated confidence and capture timestamp once
		const propagatedConfidence = entry.confidence * PROPAGATION_STRENGTH_FACTOR;
		const now = Date.now();

		// Upsert into target store with reduced confidence.
		// Destructure out updatedAt so the call matches upsert()'s Omit<KnowledgeEntry, 'updatedAt'> signature.
		// upsert() sets updatedAt internally via Date.now().
		const { updatedAt: _omit, ...entryWithoutTimestamp } = { ...entry };
		await deps.targetKnowledge.upsert({
			...entryWithoutTimestamp,
			source: "propagated",
			confidence: propagatedConfidence,
		});

		const event: PropagationEvent = {
			sourcePetId,
			targetPetId,
			knowledgeId: entry.id,
			topic: entry.topic,
			originalConfidence: entry.confidence,
			propagatedConfidence,
			propagatedAt: now,
		};
		propagated.push(event);

		logger.info("Knowledge propagated", {
			sourcePetId,
			targetPetId,
			knowledgeId: entry.id,
			topic: entry.topic,
			originalConfidence: entry.confidence,
			propagatedConfidence,
		});
	}

	return { propagated, skippedLowConfidence, skippedAlreadyKnown };
}
