/**
 * Collaboration detector — determines if a message requires multi-pet collaboration.
 */

const COLLAB_PATTERNS = [
	/같이\s*해/,
	/둘이서/,
	/나눠서/,
	/분담/,
	/협업/,
	/collaborate/i,
	/together/i,
	/both of you/i,
];

export type CollabDetection = {
	isCollab: boolean;
	/** Which pet IDs were mentioned. */
	mentionedPets: string[];
};

/**
 * Detect if a message requires collaboration.
 * Returns true if:
 * 1. Multiple bot mentions in the message, OR
 * 2. Explicit collaboration keywords present
 */
export function detectCollaboration(
	content: string,
	botMentionIds: string[],
): CollabDetection {
	// Count how many different bots are mentioned
	const mentionedPets = botMentionIds.filter(
		(id) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`),
	);

	// Multiple bots mentioned
	if (mentionedPets.length >= 2) {
		return { isCollab: true, mentionedPets };
	}

	// Explicit collaboration keywords
	const hasCollabKeyword = COLLAB_PATTERNS.some((p) => p.test(content));
	if (hasCollabKeyword && mentionedPets.length >= 1) {
		return { isCollab: true, mentionedPets };
	}

	return { isCollab: false, mentionedPets };
}
