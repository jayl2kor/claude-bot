/**
 * NDJSON line parser for Claude CLI stream-json output.
 * Reference: Claude-code bridge/sessionRunner.ts extractActivities()
 */

import type {
	AssistantMessage,
	ClaudeMessage,
	SessionActivity,
} from "./types.js";

/** Safely parse a JSON line. Returns null on failure (never throws). */
export function parseLine(line: string): ClaudeMessage | null {
	try {
		const parsed = JSON.parse(line);
		if (parsed && typeof parsed === "object" && "type" in parsed) {
			return parsed as ClaudeMessage;
		}
		return null;
	} catch {
		return null;
	}
}

/** Extract the final text from an assistant message's content blocks. */
export function extractText(msg: AssistantMessage): string {
	return msg.message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/** Extract session activities from a parsed message (for status tracking). */
export function extractActivities(msg: ClaudeMessage): SessionActivity[] {
	const now = Date.now();
	const activities: SessionActivity[] = [];

	if (msg.type === "assistant") {
		for (const block of msg.message.content) {
			if (block.type === "tool_use") {
				activities.push({
					type: "tool_start",
					summary: toolSummary(block.name, block.input),
					timestamp: now,
				});
			} else if (block.type === "text" && block.text.length > 0) {
				activities.push({
					type: "text",
					summary: block.text.slice(0, 80),
					timestamp: now,
				});
			}
		}
	} else if (msg.type === "result") {
		if (msg.subtype === "success") {
			activities.push({ type: "result", summary: "Completed", timestamp: now });
		} else {
			activities.push({
				type: "error",
				summary: `Error: ${msg.subtype}`,
				timestamp: now,
			});
		}
	}

	return activities;
}

const TOOL_VERBS: Record<string, string> = {
	Read: "Reading",
	Write: "Writing",
	Edit: "Editing",
	Bash: "Running",
	Glob: "Searching",
	Grep: "Searching",
	WebFetch: "Fetching",
	WebSearch: "Searching",
};

function toolSummary(name: string, input: Record<string, unknown>): string {
	const verb = TOOL_VERBS[name] ?? name;
	const target =
		(input.file_path as string | undefined) ??
		(input.pattern as string | undefined) ??
		(input.command as string | undefined)?.slice(0, 60) ??
		"";
	return target ? `${verb} ${target}` : verb;
}
