import { describe, expect, it } from "vitest";
import { createExecutor } from "./factory.js";

describe("createExecutor", () => {
	it("returns a callable executor for claude backend", () => {
		const executor = createExecutor("claude");
		expect(typeof executor).toBe("function");
	});

	it("returns a callable executor for codex backend", () => {
		const executor = createExecutor("codex");
		expect(typeof executor).toBe("function");
	});
});
