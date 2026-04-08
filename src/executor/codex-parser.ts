import type { SessionActivity } from "./types.js";
import type { CodexEvent } from "./codex-types.js";

/** Safely parse one Codex JSONL line. */
export function parseCodexLine(line: string): CodexEvent | null {
	try {
		const parsed = JSON.parse(line);
		if (
			parsed &&
			typeof parsed === "object" &&
			"type" in parsed &&
			typeof (parsed as { type?: unknown }).type === "string"
		) {
			return parsed as CodexEvent;
		}
		return null;
	} catch {
		return null;
	}
}

/** Extract streamed assistant text from a Codex event. */
export function extractCodexText(event: CodexEvent): string | null {
	if (!isItemCompletedEvent(event)) return null;
	if (event.item.type !== "agent_message") return null;

	const text = coerceText(event.item.text ?? event.item.content ?? event.item.message);
	return text?.trim() ? text : null;
}

/** Extract session activities from a Codex event. */
export function extractCodexActivities(event: CodexEvent): SessionActivity[] {
	const now = Date.now();
	const activities: SessionActivity[] = [];

	if (isItemStartedEvent(event) && event.item.type === "command_execution") {
		const command = String(event.item.command ?? "").slice(0, 80);
		activities.push({
			type: "tool_start",
			summary: command ? `Running ${command}` : "Running command",
			timestamp: now,
		});
		return activities;
	}

	if (isItemCompletedEvent(event) && event.item.type === "command_execution") {
		const command = String(event.item.command ?? "").slice(0, 50);
		const exitCode = event.item.exit_code;
		const status = exitCode === null || exitCode === undefined
			? "completed"
			: `exit ${exitCode}`;
		activities.push({
			type: exitCode && exitCode !== 0 ? "error" : "result",
			summary: command ? `${command} (${status})` : `Command ${status}`,
			timestamp: now,
		});
		return activities;
	}

	const text = extractCodexText(event);
	if (text) {
		activities.push({
			type: "text",
			summary: text.slice(0, 80),
			timestamp: now,
		});
		return activities;
	}

	if (event.type === "turn.completed") {
		activities.push({ type: "result", summary: "Completed", timestamp: now });
		return activities;
	}

	if (event.type === "turn.failed" || event.type === "error") {
		activities.push({
			type: "error",
			summary: extractCodexErrorMessage(event),
			timestamp: now,
		});
		return activities;
	}

	return activities;
}

export function extractCodexErrorMessage(event: CodexEvent): string {
	if (event.type === "turn.failed") {
		if (event.error && typeof event.error === "object") {
			const raw = (event.error as { message?: unknown }).message;
			return typeof raw === "string" ? raw : "Turn failed";
		}
		return "Turn failed";
	}
	if (event.type === "error") {
		return typeof event.message === "string" ? event.message : "Codex error";
	}
	return "Unknown error";
}

function coerceText(value: unknown): string | null {
	if (typeof value === "string") return value;

	if (Array.isArray(value)) {
		const parts = value
			.map((item) => {
				if (typeof item === "string") return item;
				if (
					item &&
					typeof item === "object" &&
					"text" in item &&
					typeof (item as { text?: unknown }).text === "string"
				) {
					return (item as { text: string }).text;
				}
				return "";
			})
			.filter(Boolean);
		return parts.join("\n");
	}

	return null;
}

function isItemStartedEvent(
	event: CodexEvent,
): event is Extract<CodexEvent, { type: "item.started" }> {
	if (event.type !== "item.started") return false;
	return !!event.item && typeof event.item === "object";
}

function isItemCompletedEvent(
	event: CodexEvent,
): event is Extract<CodexEvent, { type: "item.completed" }> {
	if (event.type !== "item.completed") return false;
	return !!event.item && typeof event.item === "object";
}
