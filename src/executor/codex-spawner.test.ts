import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "./codex-spawner.js";

describe("buildCodexArgs", () => {
	it("builds basic codex exec args", () => {
		const args = buildCodexArgs({
			prompt: "hello",
		});
		expect(args[0]).toBe("exec");
		expect(args[1]).toBe("hello");
		expect(args).toContain("--json");
	});

	it("prepends system prompt to user prompt when provided", () => {
		const args = buildCodexArgs({
			prompt: "user question",
			systemPrompt: "You are a helpful assistant",
		});
		expect(args[1]).toContain("You are a helpful assistant");
		expect(args[1]).toContain("user question");
	});

	it("includes model, cwd, and skip-permission flags", () => {
		const args = buildCodexArgs({
			prompt: "do work",
			model: "o3",
			cwd: "/workspace",
			skipPermissions: true,
		});
		expect(args).toContain("-m");
		expect(args).toContain("o3");
		expect(args).toContain("-C");
		expect(args).toContain("/workspace");
		expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});
});
