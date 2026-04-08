import { describe, expect, it } from "vitest";
import { createClaudeExecutor } from "./claude-spawner.js";
import { createCodexExecutor } from "./codex-spawner.js";
import { createExecutor } from "./factory.js";

describe("createExecutor", () => {
	it("returns the Claude executor for claude backend", () => {
		const executor = createExecutor("claude");
		expect(executor).toBe(createClaudeExecutor);
	});

	it("returns the Codex executor for codex backend", () => {
		const executor = createExecutor("codex");
		expect(executor).toBe(createCodexExecutor);
	});

	it("throws for unsupported backend at runtime", () => {
		expect(() => createExecutor("invalid-backend" as never)).toThrow(
			"Unsupported backend",
		);
	});
});
