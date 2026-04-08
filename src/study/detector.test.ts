/**
 * Tests for study command detector — covers:
 * - Korean imperative study patterns (공부해, 알아봐, 조사해줘, 학습해, 리서치해)
 * - /study slash command
 * - Topic extraction with particle removal
 * - Negative cases: narrative forms, teaching, unrelated
 */

import { describe, expect, it } from "vitest";
import { detectStudyCommand } from "./detector.js";

describe("detectStudyCommand — positive detection", () => {
	it("detects '~에 대해 공부해'", () => {
		const result = detectStudyCommand("Docker 네트워크에 대해 공부해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("Docker 네트워크");
	});

	it("detects '~에 대해서 공부해'", () => {
		const result = detectStudyCommand("쿠버네티스에 대해서 공부해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("쿠버네티스");
	});

	it("detects '~ 공부해'", () => {
		const result = detectStudyCommand("TypeScript 제네릭 공부해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("TypeScript 제네릭");
	});

	it("detects '~ 공부좀 해'", () => {
		const result = detectStudyCommand("Docker 네트워크에 대해 공부좀 해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("Docker 네트워크");
	});

	it("detects '~ 공부해봐'", () => {
		const result = detectStudyCommand("React hooks 공부해봐");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("React hooks");
	});

	it("detects '~에 대해 알아봐'", () => {
		const result = detectStudyCommand("GraphQL에 대해 알아봐");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("GraphQL");
	});

	it("detects '~ 알아봐'", () => {
		const result = detectStudyCommand("Redis 캐싱 알아봐");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("Redis 캐싱");
	});

	it("detects '~ 조사해줘'", () => {
		const result = detectStudyCommand("마이크로서비스 아키텍처 조사해줘");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("마이크로서비스 아키텍처");
	});

	it("detects '~ 조사해'", () => {
		const result = detectStudyCommand("CI/CD 파이프라인 조사해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("CI/CD 파이프라인");
	});

	it("detects '~ 학습해'", () => {
		const result = detectStudyCommand("머신러닝 기초를 학습해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("머신러닝 기초");
	});

	it("detects '~ 리서치해'", () => {
		const result = detectStudyCommand("블록체인 합의 알고리즘 리서치해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("블록체인 합의 알고리즘");
	});

	it("detects '~ 리서치해줘'", () => {
		const result = detectStudyCommand("WebAssembly 리서치해줘");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("WebAssembly");
	});

	it("detects '/study <topic>' command", () => {
		const result = detectStudyCommand("/study Docker networking");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("Docker networking");
	});

	it("detects '/study' with Korean topic", () => {
		const result = detectStudyCommand("/study 쿠버네티스 네트워킹");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("쿠버네티스 네트워킹");
	});
});

describe("detectStudyCommand — topic extraction with particle removal", () => {
	it("removes '에 대해' particle", () => {
		const result = detectStudyCommand("Docker에 대해 공부해");
		expect(result.topic).toBe("Docker");
	});

	it("removes '에 대해서' particle", () => {
		const result = detectStudyCommand("Rust에 대해서 알아봐");
		expect(result.topic).toBe("Rust");
	});

	it("removes '을' particle", () => {
		const result = detectStudyCommand("자바스크립트를 공부해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("자바스크립트");
	});

	it("removes '를' particle", () => {
		const result = detectStudyCommand("파이썬을 학습해");
		expect(result.detected).toBe(true);
		expect(result.topic).toBe("파이썬");
	});

	it("removes '좀' from topic", () => {
		const result = detectStudyCommand("네트워크 좀 공부해");
		expect(result.topic).toBe("네트워크");
	});

	it("trims whitespace from extracted topic", () => {
		const result = detectStudyCommand("  Docker 네트워크  에 대해 공부해");
		expect(result.topic).toBe("Docker 네트워크");
	});
});

describe("detectStudyCommand — negative cases", () => {
	it("rejects narrative past tense '공부했어'", () => {
		const result = detectStudyCommand("오늘 공부 열심히 했어");
		expect(result.detected).toBe(false);
	});

	it("rejects narrative past tense '공부했다'", () => {
		const result = detectStudyCommand("어제 Docker 공부했다");
		expect(result.detected).toBe(false);
	});

	it("rejects narrative '공부해봤는데'", () => {
		const result = detectStudyCommand("나 어제 React 공부해봤는데 어렵더라");
		expect(result.detected).toBe(false);
	});

	it("rejects teaching commands", () => {
		const result = detectStudyCommand("기억해: Docker는 컨테이너 기술이야");
		expect(result.detected).toBe(false);
	});

	it("rejects general conversation", () => {
		const result = detectStudyCommand("안녕 오늘 날씨 어때?");
		expect(result.detected).toBe(false);
	});

	it("rejects empty string", () => {
		const result = detectStudyCommand("");
		expect(result.detected).toBe(false);
	});

	it("rejects '/study' without topic", () => {
		const result = detectStudyCommand("/study");
		expect(result.detected).toBe(false);
	});

	it("rejects '/study ' with only whitespace after", () => {
		const result = detectStudyCommand("/study   ");
		expect(result.detected).toBe(false);
	});
});
