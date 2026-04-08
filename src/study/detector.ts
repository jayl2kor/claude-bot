/**
 * Study command detector.
 * Identifies when a user is requesting the pet to study a topic.
 *
 * Patterns:
 * - Korean imperative: 공부해, 알아봐, 조사해(줘), 학습해, 리서치해(줘)
 * - Slash command: /study <topic>
 *
 * Excludes narrative forms: 공부했어, 공부했다, 공부해봤는데
 */

export type StudyCommandResult = {
	readonly detected: boolean;
	readonly topic?: string;
};

/** Narrative past-tense patterns that should NOT trigger study. */
const NARRATIVE_PATTERNS = [
	/공부\s*했/, // 공부했어, 공부했다
	/공부해봤/, // 공부해봤는데
	/기억해[:\s]/, // teaching commands
	/알아둬[:\s]/, // teaching commands
];

/**
 * Study command patterns.
 * Each pattern captures the topic (group 1) and matches a study-imperative ending.
 */
const STUDY_PATTERNS: Array<{
	regex: RegExp;
	topicGroup: number;
}> = [
	// /study <topic>
	{ regex: /^\/study\s+(.+)/i, topicGroup: 1 },
	// ~에 대해(서) 공부(좀) 해(봐)
	{ regex: /(.+?)에\s*대해서?\s*공부\s*좀?\s*해/, topicGroup: 1 },
	// ~을/를 공부해(봐)
	{ regex: /(.+?)[을를]\s*공부\s*좀?\s*해/, topicGroup: 1 },
	// ~ 공부(좀) 해(봐)
	{ regex: /(.+?)\s+공부\s*좀?\s*해/, topicGroup: 1 },
	// ~에 대해(서) 알아봐
	{ regex: /(.+?)에\s*대해서?\s*알아봐/, topicGroup: 1 },
	// ~을/를 알아봐
	{ regex: /(.+?)[을를]\s*알아봐/, topicGroup: 1 },
	// ~ 알아봐
	{ regex: /(.+?)\s+알아봐/, topicGroup: 1 },
	// ~에 대해(서) 조사해(줘)
	{ regex: /(.+?)에\s*대해서?\s*조사해/, topicGroup: 1 },
	// ~ 조사해(줘)
	{ regex: /(.+?)\s+조사해/, topicGroup: 1 },
	// ~을/를 학습해
	{ regex: /(.+?)[을를]\s*학습해/, topicGroup: 1 },
	// ~ 학습해
	{ regex: /(.+?)\s+학습해/, topicGroup: 1 },
	// ~에 대해(서) 리서치해(줘)
	{ regex: /(.+?)에\s*대해서?\s*리서치해/, topicGroup: 1 },
	// ~ 리서치해(줘)
	{ regex: /(.+?)\s+리서치해/, topicGroup: 1 },
];

/**
 * Detect a study command in the given text.
 * Returns { detected: true, topic } if a study command is found.
 * Returns { detected: false } otherwise.
 */
export function detectStudyCommand(text: string): StudyCommandResult {
	const trimmed = text.trim();
	if (!trimmed) return { detected: false };

	// Check narrative exclusions first
	for (const pattern of NARRATIVE_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { detected: false };
		}
	}

	// Try each study pattern
	for (const { regex, topicGroup } of STUDY_PATTERNS) {
		const match = trimmed.match(regex);
		if (match) {
			const rawTopic = match[topicGroup];
			if (!rawTopic) continue;

			const topic = cleanTopic(rawTopic);
			if (!topic) continue;

			return { detected: true, topic };
		}
	}

	return { detected: false };
}

/**
 * Clean extracted topic by removing Korean particles and extra whitespace.
 */
function cleanTopic(raw: string): string {
	let topic = raw.trim();

	// Remove trailing particles: 을, 를, 좀, 에 대해(서)
	topic = topic.replace(/[을를]$/, "");
	topic = topic.replace(/\s*좀$/, "");
	topic = topic.replace(/에\s*대해서?$/, "");

	// Collapse whitespace
	topic = topic.replace(/\s+/g, " ").trim();

	return topic;
}
