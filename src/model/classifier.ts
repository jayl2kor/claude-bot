/**
 * Pure message classifier for smart model selection.
 *
 * Classifies incoming messages to determine the appropriate Claude model tier.
 * Rules are evaluated in priority order (first match wins).
 *
 * This is a pure function: no async, no side effects, deterministic output.
 */

import type {
	ClassificationContext,
	ClassificationResult,
	ModelTier,
} from "./types.js";

const MODEL_NAMES: readonly ModelTier[] = ["haiku", "sonnet", "opus"];

const KOREAN_OVERRIDE_SUFFIXES = [
	"로 답변해",
	"로 답변해줘",
	"써줘",
	" 써줘",
	"사용해",
	" 사용해",
	"사용해줘",
	" 사용해줘",
];

const ENGLISH_OVERRIDE_RE = /\buse\s+(haiku|sonnet|opus)\b/i;

export function extractUserModelOverride(text: string): ModelTier | null {
	const lower = text.toLowerCase();

	const engMatch = ENGLISH_OVERRIDE_RE.exec(lower);
	if (engMatch) {
		return engMatch[1] as ModelTier;
	}

	for (const model of MODEL_NAMES) {
		for (const suffix of KOREAN_OVERRIDE_SUFFIXES) {
			if (lower.includes(`${model}${suffix}`)) {
				return model;
			}
		}
	}

	return null;
}

const KOREAN_GREETINGS = [
	"안녕",
	"안녕하세요",
	"반가워",
	"반갑",
	"ㅎㅇ",
	"ㅋㅋ",
	"ㅎㅎ",
	"ㄱㅅ",
	"ㅇㅇ",
	"ㅇㅋ",
	"ㄴㄴ",
	"ㄹㅇ",
];

const ENGLISH_GREETINGS = [
	"hi", "hello", "hey", "yo", "sup",
	"good morning", "good evening", "good night", "gm", "gn",
];

const SHORT_MSG_THRESHOLD = 30;

function isGreeting(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length > SHORT_MSG_THRESHOLD) return false;

	const lower = trimmed.toLowerCase();

	for (const g of KOREAN_GREETINGS) {
		if (lower.includes(g)) return true;
	}

	for (const g of ENGLISH_GREETINGS) {
		if (lower === g || lower === `${g}!` || lower === `${g}.`) return true;
	}

	return false;
}

const COMPLEX_KEYWORDS_KR = [
	"설계", "아키텍처", "깊이 분석",
	"심층 분석", "리팩토링 전략",
	"시스템 디자인", "최적화 전략",
];

const COMPLEX_KEYWORDS_EN = [
	"architecture", "design pattern", "system design",
	"deep analysis", "in-depth review", "refactoring strategy",
];

const CODE_BLOCK_RE = /```[\s\S]*?```/;

function hasComplexKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	for (const kw of COMPLEX_KEYWORDS_KR) {
		if (lower.includes(kw)) return true;
	}
	for (const kw of COMPLEX_KEYWORDS_EN) {
		if (lower.includes(kw)) return true;
	}
	return false;
}

function hasCodeBlockWithLength(text: string, minLength: number): boolean {
	return CODE_BLOCK_RE.test(text) && text.length >= minLength;
}

const TECHNICAL_KEYWORDS = [
	"함수", "변수", "클래스", "타입",
	"인터페이스", "모듈", "패키지",
	"라이브러리", "프레임워크",
	"데이터베이스", "api", "rest", "graphql", "sql",
	"docker", "kubernetes", "function", "class", "type", "interface",
	"module", "import", "export", "typescript", "javascript", "python",
	"react", "node", "npm", "git", "deploy", "debug", "error", "bug",
	"fix", "test", "코드", "구현", "개발", "배포",
	"테스트", "디버그", "에러", "버그",
	"제네릭", "엔드포인트",
];

function hasTechnicalKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	for (const kw of TECHNICAL_KEYWORDS) {
		if (lower.includes(kw)) return true;
	}
	return false;
}

const SESSION_CONTINUITY_WINDOW_MS = 30 * 60 * 1000;

function shouldKeepPreviousModel(
	confidence: number,
	ctx: ClassificationContext,
): ModelTier | null {
	if (confidence >= 0.6) return null;
	if (!ctx.previousModel || !ctx.previousTimestamp) return null;
	const elapsed = ctx.timestamp - ctx.previousTimestamp;
	if (elapsed > SESSION_CONTINUITY_WINDOW_MS) return null;
	return ctx.previousModel;
}

export function classifyMessage(
	text: string,
	ctx: ClassificationContext,
): ClassificationResult {
	const override = extractUserModelOverride(text);
	if (override !== null) {
		return {
			tier: override,
			confidence: 1,
			reason: `User requested ${override}`,
			isOverride: true,
		};
	}

	if (isGreeting(text)) {
		return {
			tier: "haiku",
			confidence: 0.9,
			reason: "Short greeting pattern",
			isOverride: false,
		};
	}

	if (hasComplexKeywords(text)) {
		return {
			tier: "opus",
			confidence: 0.85,
			reason: "Complex/architectural keywords detected",
			isOverride: false,
		};
	}

	if (hasCodeBlockWithLength(text, 500)) {
		return {
			tier: "opus",
			confidence: 0.8,
			reason: "Long code block requiring deep analysis",
			isOverride: false,
		};
	}

	if (hasTechnicalKeywords(text)) {
		return {
			tier: "sonnet",
			confidence: 0.75,
			reason: "Technical content detected",
			isOverride: false,
		};
	}

	const defaultResult: ClassificationResult = {
		tier: ctx.defaultModel ?? "sonnet",
		confidence: 0.5,
		reason: "Default classification",
		isOverride: false,
	};

	const kept = shouldKeepPreviousModel(defaultResult.confidence, ctx);
	if (kept !== null) {
		return {
			tier: kept,
			confidence: 0.5,
			reason: `Session continuity (keeping ${kept} from recent context)`,
			isOverride: false,
		};
	}

	return defaultResult;
}
