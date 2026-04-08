/**
 * Types for `codex exec --json` streaming output.
 */

export type CodexUsage = {
	input_tokens?: number;
	output_tokens?: number;
	[key: string]: unknown;
};

export type CodexAgentMessageItem = {
	id?: string;
	type: "agent_message";
	text?: string;
	content?: unknown;
	message?: string;
};

export type CodexCommandExecutionItem = {
	id?: string;
	type: "command_execution";
	command?: string;
	aggregated_output?: string;
	exit_code?: number | null;
	status?: string;
};

export type CodexItem =
	| CodexAgentMessageItem
	| CodexCommandExecutionItem
	| { id?: string; type: string; [key: string]: unknown };

export type CodexEvent =
	| { type: "thread.started"; thread_id?: string }
	| { type: "turn.started" }
	| { type: "item.started"; item: CodexItem }
	| { type: "item.completed"; item: CodexItem }
	| { type: "turn.completed"; usage?: CodexUsage }
	| { type: "turn.failed"; error?: { message?: string } }
	| { type: "error"; message?: string }
	| { type: string; [key: string]: unknown };
