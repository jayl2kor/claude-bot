import { describe, expect, it } from "vitest";
import { classifyMessage, extractUserModelOverride } from "./classifier.js";
import type { ClassificationContext } from "./types.js";

function makeCtx(overrides: Partial<ClassificationContext> = {}): ClassificationContext {
	return { userId: "user1", channelId: "chan1", timestamp: Date.now(), ...overrides };
}

describe("extractUserModelOverride", () => {
	it("returns opus for 'opus로 답변해줘'", () => {
		expect(extractUserModelOverride("opus로 답변해줘")).toBe("opus");
	});
	it("returns haiku for 'haiku 써줘'", () => {
		expect(extractUserModelOverride("haiku 써줘")).toBe("haiku");
	});
	it("returns sonnet for 'sonnet 사용해'", () => {
		expect(extractUserModelOverride("sonnet 사용해")).toBe("sonnet");
	});
	it("returns opus for 'use opus'", () => {
		expect(extractUserModelOverride("use opus")).toBe("opus");
	});
	it("returns null for no override", () => {
		expect(extractUserModelOverride("안녕하세요")).toBeNull();
	});
	it("returns null for empty", () => {
		expect(extractUserModelOverride("")).toBeNull();
	});
	it("is case-insensitive", () => {
		expect(extractUserModelOverride("OPUS로 답변해")).toBe("opus");
		expect(extractUserModelOverride("Use HAIKU")).toBe("haiku");
	});
});

describe("classifyMessage - greetings -> haiku", () => {
	it("classifies '안녕' as haiku", () => {
		const r = classifyMessage("안녕", makeCtx());
		expect(r.tier).toBe("haiku");
		expect(r.confidence).toBeGreaterThanOrEqual(0.8);
		expect(r.isOverride).toBe(false);
	});
	it("classifies 'ㅎㅇ' as haiku", () => {
		expect(classifyMessage("ㅎㅇ", makeCtx()).tier).toBe("haiku");
	});
	it("classifies '반가워' as haiku", () => {
		expect(classifyMessage("반가워", makeCtx()).tier).toBe("haiku");
	});
	it("classifies 'ㅋㅋ' as haiku", () => {
		expect(classifyMessage("ㅋㅋ", makeCtx()).tier).toBe("haiku");
	});
	it("classifies 'hi' as haiku", () => {
		expect(classifyMessage("hi", makeCtx()).tier).toBe("haiku");
	});
	it("classifies 'hello' as haiku", () => {
		expect(classifyMessage("hello", makeCtx()).tier).toBe("haiku");
	});
});

describe("classifyMessage - complex keywords -> opus", () => {
	it("classifies 'Docker 아키텍처 설계해줘' as opus", () => {
		expect(classifyMessage("Docker 아키텍처 설계해줘", makeCtx()).tier).toBe("opus");
	});
	it("classifies messages with '설계' as opus", () => {
		expect(classifyMessage("이 시스템을 설계하는 방법", makeCtx()).tier).toBe("opus");
	});
	it("classifies messages with 'architecture' as opus", () => {
		expect(classifyMessage("Explain the architecture of this system", makeCtx()).tier).toBe("opus");
	});
	it("classifies messages with 'design pattern' as opus", () => {
		expect(classifyMessage("Which design pattern should I use?", makeCtx()).tier).toBe("opus");
	});
});

describe("classifyMessage - code block + 500+ chars -> opus", () => {
	it("classifies long code block as opus", () => {
		const code = "```typescript\n" + "x".repeat(500) + "\n```";
		expect(classifyMessage(`review\n${code}`, makeCtx()).tier).toBe("opus");
	});
	it("classifies short code block as sonnet", () => {
		const code = "```typescript\nconst x = 1;\n```";
		expect(classifyMessage(`코드 봐줘\n${code}`, makeCtx()).tier).toBe("sonnet");
	});
});

describe("classifyMessage - technical -> sonnet", () => {
	it("classifies '이 함수 뭐하는 거야?' as sonnet", () => {
		expect(classifyMessage("이 함수 뭐하는 거야?", makeCtx()).tier).toBe("sonnet");
	});
	it("classifies API questions as sonnet", () => {
		expect(classifyMessage("REST API 엔드포인트 만들어줘", makeCtx()).tier).toBe("sonnet");
	});
});

describe("classifyMessage - user override", () => {
	it("overrides to opus", () => {
		const r = classifyMessage("opus로 답변해줘", makeCtx());
		expect(r.tier).toBe("opus");
		expect(r.isOverride).toBe(true);
		expect(r.confidence).toBe(1);
	});
	it("override takes priority over keywords", () => {
		const r = classifyMessage("haiku 써줘, 아키텍처 설계해줘", makeCtx());
		expect(r.tier).toBe("haiku");
		expect(r.isOverride).toBe(true);
	});
});

describe("classifyMessage - session continuity", () => {
	it("keeps previous model for low confidence + recent previous", () => {
		const now = Date.now();
		const r = classifyMessage("음", makeCtx({
			previousModel: "opus",
			previousTimestamp: now - 5 * 60 * 1000,
		}));
		expect(r.tier).toBe("opus");
	});
	it("does not keep previous if too old", () => {
		const now = Date.now();
		const r = classifyMessage("음", makeCtx({
			previousModel: "opus",
			previousTimestamp: now - 35 * 60 * 1000,
			timestamp: now,
		}));
		expect(r.tier).not.toBe("opus");
	});
	it("does not keep previous if confidence is high", () => {
		const now = Date.now();
		const r = classifyMessage("안녕", makeCtx({
			previousModel: "opus",
			previousTimestamp: now - 5 * 60 * 1000,
		}));
		expect(r.tier).toBe("haiku");
	});
});

describe("classifyMessage - default -> sonnet", () => {
	it("classifies general messages as sonnet", () => {
		expect(classifyMessage("오늘 날씨가 좋다고 하더라", makeCtx()).tier).toBe("sonnet");
	});
	it("returns valid result for empty string", () => {
		const r = classifyMessage("", makeCtx());
		expect(r.tier).toBeDefined();
		expect(r.confidence).toBeGreaterThan(0);
	});
});

describe("classifyMessage - pure function", () => {
	it("returns consistent results", () => {
		const ctx = makeCtx();
		const r1 = classifyMessage("안녕", ctx);
		const r2 = classifyMessage("안녕", ctx);
		expect(r1.tier).toBe(r2.tier);
		expect(r1.confidence).toBe(r2.confidence);
	});
	it("does not modify context", () => {
		const ctx = makeCtx({ previousModel: "sonnet" });
		const ctxCopy = { ...ctx };
		classifyMessage("test", ctx);
		expect(ctx).toEqual(ctxCopy);
	});
});
