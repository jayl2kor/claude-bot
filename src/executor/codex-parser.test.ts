import { describe, expect, it } from "vitest";
import {
	extractCodexActivities,
	extractCodexErrorMessage,
	extractCodexText,
	parseCodexLine,
} from "./codex-parser.js";

describe("parseCodexLine", () => {
	it("parses valid json event lines", () => {
		const parsed = parseCodexLine('{"type":"turn.completed"}');
		expect(parsed).not.toBeNull();
		expect(parsed?.type).toBe("turn.completed");
	});

	it("returns null for invalid json", () => {
		expect(parseCodexLine("{not-json")).toBeNull();
	});

	it("returns null when type is missing", () => {
		expect(parseCodexLine('{"foo":"bar"}')).toBeNull();
	});
});

describe("extractCodexText", () => {
	it("extracts text from completed agent_message", () => {
		const text = extractCodexText({
			type: "item.completed",
			item: { type: "agent_message", text: "hello from codex" },
		});
		expect(text).toBe("hello from codex");
	});

	it("returns null for non-agent messages", () => {
		const text = extractCodexText({
			type: "item.completed",
			item: { type: "command_execution", command: "ls -la" },
		});
		expect(text).toBeNull();
	});
});

describe("extractCodexActivities", () => {
	it("extracts command start activity", () => {
		const activities = extractCodexActivities({
			type: "item.started",
			item: { type: "command_execution", command: "npm test" },
		});
		expect(activities).toHaveLength(1);
		expect(activities[0]?.type).toBe("tool_start");
		expect(activities[0]?.summary).toContain("npm test");
	});

	it("extracts completion activity from turn.completed", () => {
		const activities = extractCodexActivities({
			type: "turn.completed",
		});
		expect(activities).toHaveLength(1);
		expect(activities[0]?.type).toBe("result");
	});

	it("extracts error activity from turn.failed", () => {
		const activities = extractCodexActivities({
			type: "turn.failed",
			error: { message: "tool crashed" },
		});
		expect(activities).toHaveLength(1);
		expect(activities[0]?.type).toBe("error");
		expect(activities[0]?.summary).toContain("tool crashed");
	});
});

describe("extractCodexErrorMessage", () => {
	it("reads turn.failed error messages", () => {
		const msg = extractCodexErrorMessage({
			type: "turn.failed",
			error: { message: "bad request" },
		});
		expect(msg).toBe("bad request");
	});

	it("reads top-level error messages", () => {
		const msg = extractCodexErrorMessage({
			type: "error",
			message: "connection lost",
		});
		expect(msg).toBe("connection lost");
	});
});
