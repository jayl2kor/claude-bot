import { createClaudeExecutor } from "./claude-spawner.js";
import { createCodexExecutor } from "./codex-spawner.js";
import type { ExecutorFactory, LLMBackend } from "./interface.js";

export function createExecutor(backend: LLMBackend): ExecutorFactory {
	switch (backend) {
		case "claude":
			return createClaudeExecutor;
		case "codex":
			return createCodexExecutor;
		default: {
			const exhaustive: never = backend;
			throw new Error(`Unsupported backend: ${String(exhaustive)}`);
		}
	}
}
