/**
 * Teaching intent detector.
 * Identifies when a user is explicitly or implicitly teaching the pet.
 *
 * Three categories:
 * - explicit: "기억해:", "알아둬:", "/teach ..."
 * - correction: "아니야, 사실은...", "틀렸어, ..."
 * - preference: "나는 ~좋아해", "~하지 마"
 */

export type TeachingIntent = {
	type: "explicit" | "correction" | "preference";
	/** The raw text that triggered detection. */
	trigger: string;
	/** Extracted payload (the thing to remember). */
	payload: string;
	/** Confidence 0-1. */
	confidence: number;
};

const EXPLICIT_PATTERNS: Array<{
	regex: RegExp;
	extract: (m: RegExpMatchArray) => string;
}> = [
	{ regex: /^\/teach\s+(.+)/i, extract: (m) => m[1]! },
	{ regex: /기억해[:\s]+(.+)/i, extract: (m) => m[1]! },
	{ regex: /알아둬[:\s]+(.+)/i, extract: (m) => m[1]! },
	{ regex: /이건\s+(.+?)[이야이에요입니다]/, extract: (m) => m[1]! },
	{ regex: /remember[:\s]+(.+)/i, extract: (m) => m[1]! },
	{ regex: /잊지\s*마[:\s]+(.+)/i, extract: (m) => m[1]! },
	{ regex: /메모해[:\s]+(.+)/i, extract: (m) => m[1]! },
];

const CORRECTION_PATTERNS: Array<{
	regex: RegExp;
	extract: (m: RegExpMatchArray) => string;
}> = [
	{ regex: /아니야[,\s]+(.+)/, extract: (m) => m[1]! },
	{ regex: /틀렸어[,\s]+(.+)/, extract: (m) => m[1]! },
	{ regex: /아닌데[,\s]+(.+)/, extract: (m) => m[1]! },
	{ regex: /(?:사실은|실은)[,\s]+(.+)/, extract: (m) => m[1]! },
	{ regex: /그게\s*아니라[,\s]+(.+)/, extract: (m) => m[1]! },
	{ regex: /no[,\s]+(?:actually|it's)\s+(.+)/i, extract: (m) => m[1]! },
	{ regex: /(?:정정|수정)[:\s]+(.+)/, extract: (m) => m[1]! },
];

const PREFERENCE_PATTERNS: Array<{
	regex: RegExp;
	extract: (m: RegExpMatchArray) => string;
}> = [
	{
		regex: /나는?\s+(.+?)\s*(?:좋아해|좋아|선호해)/,
		extract: (m) => `좋아하는 것: ${m[1]}`,
	},
	{
		regex: /나는?\s+(.+?)\s*(?:싫어해|싫어|별로야)/,
		extract: (m) => `싫어하는 것: ${m[1]}`,
	},
	{
		regex: /(.+?)\s*(?:하지\s*마|안\s*했으면|안\s*좋겠)/,
		extract: (m) => `하지 말 것: ${m[1]}`,
	},
	{ regex: /(?:앞으로|다음부터)\s+(.+)/, extract: (m) => `행동 지침: ${m[1]}` },
	{
		regex: /i (?:like|love|prefer)\s+(.+)/i,
		extract: (m) => `좋아하는 것: ${m[1]}`,
	},
	{
		regex: /(?:don't|do not|never)\s+(.+)/i,
		extract: (m) => `하지 말 것: ${m[1]}`,
	},
];

/**
 * Detect teaching intent in a message.
 * Returns all detected intents sorted by confidence (highest first).
 * Returns empty array if no teaching detected.
 */
export function detectTeaching(text: string): TeachingIntent[] {
	const intents: TeachingIntent[] = [];

	for (const { regex, extract } of EXPLICIT_PATTERNS) {
		const match = text.match(regex);
		if (match) {
			intents.push({
				type: "explicit",
				trigger: match[0],
				payload: extract(match).trim(),
				confidence: 0.95,
			});
		}
	}

	for (const { regex, extract } of CORRECTION_PATTERNS) {
		const match = text.match(regex);
		if (match) {
			intents.push({
				type: "correction",
				trigger: match[0],
				payload: extract(match).trim(),
				confidence: 0.85,
			});
		}
	}

	for (const { regex, extract } of PREFERENCE_PATTERNS) {
		const match = text.match(regex);
		if (match) {
			intents.push({
				type: "preference",
				trigger: match[0],
				payload: extract(match).trim(),
				confidence: 0.7,
			});
		}
	}

	return intents.sort((a, b) => b.confidence - a.confidence);
}
