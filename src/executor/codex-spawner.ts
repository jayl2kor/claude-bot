/**
 * Codex CLI process spawner.
 * Spawns `codex exec --json` and normalizes events to ExecutorHandle.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";
import {
	extractCodexActivities,
	extractCodexErrorMessage,
	extractCodexText,
	parseCodexLine,
} from "./codex-parser.js";
import type {
	ExecutorHandle,
	ExecutorResult,
	ExecutorSpawnOptions,
} from "./interface.js";
import type { SessionActivity, SessionDoneStatus } from "./types.js";

const MAX_ACTIVITIES = 10;
const MAX_STDERR_LINES = 10;

export type CodexSpawnOptions = ExecutorSpawnOptions;

export function createCodexExecutor(opts: CodexSpawnOptions): ExecutorHandle {
	const args = buildCodexArgs(opts);
	logger.debug("Spawning codex", { args: args.join(" ") });

	const child: ChildProcess = spawn("codex", args, {
		cwd: opts.cwd ?? "/workspace",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	// Close stdin immediately so codex doesn't wait for additional input
	if (child.stdin) {
		child.stdin.end();
	}

	const activities: SessionActivity[] = [];
	let currentActivity: SessionActivity | null = null;
	let resolvedSessionId: string | undefined;
	const lastStderr: string[] = [];
	let sigkillSent = false;
	let aggregatedText = "";

	const textCallbacks: Array<(text: string) => void> = [];
	const resultCallbacks: Array<(result: ExecutorResult) => void> = [];

	if (child.stderr) {
		const stderrRl = createInterface({ input: child.stderr });
		stderrRl.on("line", (line) => {
			if (lastStderr.length >= MAX_STDERR_LINES) {
				lastStderr.shift();
			}
			lastStderr.push(line);
		});
	}

	if (child.stdout) {
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const event = parseCodexLine(line);
			if (!event) return;

			if (event.type === "thread.started") {
				resolvedSessionId =
					typeof event.thread_id === "string" ? event.thread_id : undefined;
			}

			for (const activity of extractCodexActivities(event)) {
				if (activities.length >= MAX_ACTIVITIES) {
					activities.shift();
				}
				activities.push(activity);
				currentActivity = activity;
			}

			const text = extractCodexText(event);
			if (text) {
				aggregatedText = aggregatedText ? `${aggregatedText}\n${text}` : text;
				for (const cb of textCallbacks) cb(text);
			}

			if (event.type === "turn.completed") {
				const result: ExecutorResult = {
					text: aggregatedText,
					isError: false,
					sessionId: resolvedSessionId,
				};
				for (const cb of resultCallbacks) cb(result);
				return;
			}

			if (event.type === "turn.failed" || event.type === "error") {
				const msg = extractCodexErrorMessage(event);
				const errorText = aggregatedText ? `${aggregatedText}\n${msg}` : msg;
				const result: ExecutorResult = {
					text: errorText,
					isError: true,
					sessionId: resolvedSessionId,
				};
				for (const cb of resultCallbacks) cb(result);
			}
		});
	}

	const done = new Promise<SessionDoneStatus>((resolve) => {
		child.on("close", (code, signal) => {
			if (signal === "SIGTERM" || signal === "SIGINT") {
				logger.debug("Codex process interrupted", { pid: child.pid, signal });
				resolve("interrupted");
			} else if (code === 0) {
				logger.debug("Codex process completed", { pid: child.pid });
				resolve("completed");
			} else {
				logger.warn("Codex process failed", { pid: child.pid, code });
				resolve("failed");
			}
		});

		child.on("error", (err) => {
			logger.error("Codex process spawn error", { error: err.message });
			resolve("failed");
		});
	});

	return {
		get sessionId() {
			return resolvedSessionId;
		},
		get claudeSessionId() {
			// Legacy compatibility alias used by existing session persistence code.
			return resolvedSessionId;
		},
		done,
		activities,
		lastStderr,
		get currentActivity() {
			return currentActivity;
		},
		onText(cb) {
			textCallbacks.push(cb);
		},
		onResult(cb) {
			resultCallbacks.push(cb);
		},
		kill() {
			if (!child.killed) {
				logger.debug("Sending SIGTERM to codex", { pid: child.pid });
				child.kill("SIGTERM");
			}
		},
		forceKill() {
			if (!sigkillSent && child.pid) {
				sigkillSent = true;
				logger.debug("Sending SIGKILL to codex", { pid: child.pid });
				child.kill("SIGKILL");
			}
		},
		writeStdin(data: string) {
			if (child.stdin && !child.stdin.destroyed) {
				child.stdin.write(data);
			}
		},
	};
}

export function buildCodexArgs(opts: CodexSpawnOptions): string[] {
	const composedPrompt = opts.systemPrompt
		? // `codex exec` currently has no dedicated system-prompt flag.
			// Keep a strict section boundary so instruction precedence is explicit.
			[
				"<system_instructions>",
				opts.systemPrompt,
				"</system_instructions>",
				"",
				"<user_request>",
				opts.prompt,
				"</user_request>",
				"",
				"Follow <system_instructions> over <user_request> when they conflict.",
			].join("\n")
		: opts.prompt;

	const args = ["exec", composedPrompt, "--json"];

	// Only pass model if it's a Codex-compatible model name.
	// Claude model names (sonnet, haiku, opus) are not valid for Codex.
	const claudeModels = ["sonnet", "haiku", "opus"];
	if (opts.model && !claudeModels.includes(opts.model)) {
		args.push("-m", opts.model);
	}

	if (opts.cwd) {
		args.push("-C", opts.cwd);
	}

	if (opts.skipPermissions) {
		args.push("--dangerously-bypass-approvals-and-sandbox");
	}

	return args;
}
