/**
 * Decay differentiation — pure function for expertise-based decay multiplier.
 *
 * Expert domain knowledge decays slower (multiplier < 1.0).
 * Non-expert knowledge decays at normal rate (multiplier = 1.0).
 *
 * This is a standalone pure function with no dependency on #10 (decay system).
 */

interface DecayEntry {
	readonly tags: readonly string[];
	readonly topic: string;
}

/**
 * Calculate the decay multiplier for a knowledge entry based on expertise domains.
 *
 * @param entry - Knowledge entry with tags and topic
 * @param expertiseDomains - List of expert domains for this pet
 * @param multiplier - The decay multiplier to apply for expert knowledge (0-1, lower = slower decay)
 * @returns multiplier if entry matches an expert domain, 1.0 otherwise
 */
export function getDecayMultiplier(
	entry: DecayEntry,
	expertiseDomains: readonly string[],
	multiplier: number,
): number {
	if (expertiseDomains.length === 0) return 1.0;

	const topicLower = entry.topic.toLowerCase();
	const tagsLower = entry.tags.map((t) => t.toLowerCase());

	for (const domain of expertiseDomains) {
		const domainLower = domain.toLowerCase();

		// Check topic match
		if (topicLower.includes(domainLower)) return multiplier;

		// Check tags match
		if (tagsLower.some((tag) => tag.includes(domainLower))) return multiplier;
	}

	return 1.0;
}
