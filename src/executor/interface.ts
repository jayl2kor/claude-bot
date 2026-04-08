import type { SessionActivity, SessionDoneStatus } from "./types.js";

export type LLMBackend = "claude" | "codex";

export type ExecutorSpawnOptions = {
	/** User's message text */
	prompt: string;
	/** Optional system prompt */
	systemPrompt?: string;
	/** Resume identifier when backend supports it */
	sessionId?: string;
	/** Backend-specific model name */
	model?: string;
	/** Maximum agentic turns (backend-specific) */
	maxTurns?: number;
	/** Working directory for process execution */
	cwd?: string;
	/** Skip interactive permission/safety checks */
	skipPermissions?: boolean;
};

/**
 * Normalized final result.
 */
export type ExecutorResult = {
	text: string;
	isError: boolean;
	sessionId?: string;
};

export type ExecutorHandle = {
	readonly sessionId: string | undefined;
	/** Legacy alias kept for compatibility with existing storage logic. */
	readonly claudeSessionId?: string | undefined;
	readonly done: Promise<SessionDoneStatus>;
	readonly activities: SessionActivity[];
	readonly lastStderr: string[];
	readonly currentActivity: SessionActivity | null;
	onText(cb: (text: string) => void): void;
	onResult(cb: (result: ExecutorResult) => void): void;
	kill(): void;
	forceKill(): void;
	writeStdin(data: string): void;
};

export type ExecutorFactory = (
	opts: ExecutorSpawnOptions,
) => ExecutorHandle;
