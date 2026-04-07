/**
 * Types for Claude CLI `--output-format stream-json` NDJSON output.
 * Reference: Claude-code bridge/sessionRunner.ts
 */

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string };

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};

/** Streamed assistant message with content blocks. */
export type AssistantMessage = {
	type: "assistant";
	message: {
		id: string;
		role: "assistant";
		content: ContentBlock[];
		model: string;
		usage: Usage;
	};
};

/** Final result when Claude finishes a turn. */
export type ResultMessage = {
	type: "result";
	subtype: "success" | "error_max_turns" | "error_tool_use" | "error_model";
	result: string;
	duration_ms: number;
	duration_api_ms: number;
	num_turns: number;
	is_error: boolean;
	usage: Usage;
	session_id: string;
};

/** System message (e.g., init, compact summary). */
export type SystemMessage = {
	type: "system";
	subtype: string;
	message: string;
};

/** Any NDJSON line from Claude CLI. */
export type ClaudeMessage = AssistantMessage | ResultMessage | SystemMessage;

/** Activity tracking for status display. */
export type SessionActivity = {
	type: "tool_start" | "text" | "result" | "error";
	summary: string;
	timestamp: number;
};

/** Session completion status. */
export type SessionDoneStatus = "completed" | "failed" | "interrupted";
