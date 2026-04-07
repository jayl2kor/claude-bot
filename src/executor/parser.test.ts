/**
 * Tests for NDJSON parser — covers JSON validation (CRITICAL #2)
 * and all edge cases in parseLine / extractText / extractActivities.
 */

import { describe, expect, it } from "vitest";
import { extractActivities, extractText, parseLine } from "./parser.js";
import type { AssistantMessage, ResultMessage } from "./types.js";

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe("parseLine", () => {
	it("returns null for empty string", () => {
		expect(parseLine("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(parseLine("   ")).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		expect(parseLine("{not json}")).toBeNull();
	});

	it("returns null for valid JSON that is not an object", () => {
		expect(parseLine("42")).toBeNull();
		expect(parseLine('"hello"')).toBeNull();
		expect(parseLine("true")).toBeNull();
		expect(parseLine("null")).toBeNull();
		expect(parseLine("[]")).toBeNull();
	});

	it("returns null for object without 'type' field", () => {
		expect(parseLine('{"role":"assistant"}')).toBeNull();
	});

	it("parses a valid assistant message", () => {
		const msg: AssistantMessage = {
			type: "assistant",
			message: {
				id: "msg_1",
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				model: "claude-3",
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		};
		const result = parseLine(JSON.stringify(msg));
		expect(result).not.toBeNull();
		expect(result?.type).toBe("assistant");
	});

	it("parses a valid result message", () => {
		const msg: ResultMessage = {
			type: "result",
			subtype: "success",
			result: "done",
			duration_ms: 100,
			duration_api_ms: 90,
			num_turns: 1,
			is_error: false,
			usage: { input_tokens: 5, output_tokens: 3 },
			session_id: "sess_abc",
		};
		const result = parseLine(JSON.stringify(msg));
		expect(result?.type).toBe("result");
	});

	it("returns null for JSON array (not object)", () => {
		expect(parseLine("[1,2,3]")).toBeNull();
	});

	it("handles unicode and special characters without throwing", () => {
		expect(() => parseLine('{"type":"test","content":"<script>alert(1)</script>"}')).not.toThrow();
	});

	it("handles extremely long lines without throwing", () => {
		const longText = "x".repeat(100_000);
		const msg = JSON.stringify({ type: "assistant", text: longText });
		expect(() => parseLine(msg)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
	function makeAssistant(content: AssistantMessage["message"]["content"]): AssistantMessage {
		return {
			type: "assistant",
			message: {
				id: "msg_1",
				role: "assistant",
				content,
				model: "claude-3",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		};
	}

	it("returns empty string for empty content array", () => {
		expect(extractText(makeAssistant([]))).toBe("");
	});

	it("extracts text from a single text block", () => {
		expect(extractText(makeAssistant([{ type: "text", text: "hello" }]))).toBe("hello");
	});

	it("concatenates multiple text blocks", () => {
		const msg = makeAssistant([
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		]);
		expect(extractText(msg)).toBe("hello world");
	});

	it("ignores tool_use blocks", () => {
		const msg = makeAssistant([
			{ type: "text", text: "start " },
			{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } },
			{ type: "text", text: "end" },
		]);
		expect(extractText(msg)).toBe("start end");
	});

	it("ignores tool_result blocks", () => {
		const msg = makeAssistant([
			{ type: "tool_result", tool_use_id: "t1", content: "file content" },
			{ type: "text", text: "done" },
		]);
		expect(extractText(msg)).toBe("done");
	});

	it("returns empty string when only non-text blocks present", () => {
		const msg = makeAssistant([
			{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
		]);
		expect(extractText(msg)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// extractActivities
// ---------------------------------------------------------------------------

describe("extractActivities", () => {
	function makeAssistant(content: AssistantMessage["message"]["content"]): AssistantMessage {
		return {
			type: "assistant",
			message: {
				id: "msg_1",
				role: "assistant",
				content,
				model: "claude-3",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		};
	}

	it("returns empty array for system message", () => {
		const msg = { type: "system" as const, subtype: "init", message: "init" };
		expect(extractActivities(msg)).toEqual([]);
	});

	it("returns empty array for assistant message with no content blocks", () => {
		expect(extractActivities(makeAssistant([]))).toEqual([]);
	});

	it("extracts text activity from text block", () => {
		const activities = extractActivities(makeAssistant([{ type: "text", text: "Hello world" }]));
		expect(activities).toHaveLength(1);
		expect(activities[0]!.type).toBe("text");
		expect(activities[0]!.summary).toBe("Hello world");
		expect(activities[0]!.timestamp).toBeGreaterThan(0);
	});

	it("truncates long text summaries to 80 characters", () => {
		const longText = "a".repeat(200);
		const activities = extractActivities(makeAssistant([{ type: "text", text: longText }]));
		expect(activities[0]!.summary.length).toBe(80);
	});

	it("extracts tool_start activity from tool_use block", () => {
		const activities = extractActivities(
			makeAssistant([
				{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo/bar.ts" } },
			]),
		);
		expect(activities).toHaveLength(1);
		expect(activities[0]!.type).toBe("tool_start");
		expect(activities[0]!.summary).toContain("Reading");
	});

	it("extracts result activity for success", () => {
		const msg: ResultMessage = {
			type: "result",
			subtype: "success",
			result: "done",
			duration_ms: 100,
			duration_api_ms: 90,
			num_turns: 1,
			is_error: false,
			usage: { input_tokens: 1, output_tokens: 1 },
			session_id: "s1",
		};
		const activities = extractActivities(msg);
		expect(activities).toHaveLength(1);
		expect(activities[0]!.type).toBe("result");
	});

	it("extracts error activity for non-success subtypes", () => {
		const msg: ResultMessage = {
			type: "result",
			subtype: "error_max_turns",
			result: "",
			duration_ms: 100,
			duration_api_ms: 90,
			num_turns: 10,
			is_error: true,
			usage: { input_tokens: 1, output_tokens: 1 },
			session_id: "s1",
		};
		const activities = extractActivities(msg);
		expect(activities[0]!.type).toBe("error");
		expect(activities[0]!.summary).toContain("error_max_turns");
	});

	it("skips empty text blocks", () => {
		const activities = extractActivities(makeAssistant([{ type: "text", text: "" }]));
		expect(activities).toHaveLength(0);
	});
});
