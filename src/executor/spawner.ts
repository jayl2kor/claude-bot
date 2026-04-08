/**
 * Backward-compatible export surface for Claude spawner.
 * New code should prefer `createClaudeExecutor` from `claude-spawner.ts`.
 */

export {
	createClaudeExecutor,
	spawnClaude,
	type SpawnOptions,
	type SessionHandle,
} from "./claude-spawner.js";
