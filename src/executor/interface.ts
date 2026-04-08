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
 * `result`/`session_id`/`is_error` fields are kept for backward compatibility
 * with existing Claude-oriented call sites.
 */
export type ExecutorResult = {
	text: string;
	result: string;
	isError: boolean;
	is_error?: boolean;
	sessionId?: string;
	session_id?: string;
};

export type ExecutorHandle = {
	readonly sessionId: string | undefined;
	/** Legacy alias kept for compatibility with existing storage logic. */
	readonly claudeSessionId?: string | undefined;
	readonly done: Promise<SessionDoneStatus>;
	readonly activities: SessionActivity[];
	readonly lastStderr: string[];
	currentActivity: SessionActivity | null;
	onText(cb: (text: string) => void): void;
	onResult(cb: (result: ExecutorResult) => void): void;
	kill(): void;
	forceKill(): void;
	writeStdin(data: string): void;
};

export type ExecutorFactory = (
	opts: ExecutorSpawnOptions,
) => ExecutorHandle;
