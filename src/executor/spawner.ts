/**
 * Claude CLI process spawner.
 * Reference: Claude-code bridge/sessionRunner.ts createSessionSpawner()
 *
 * Spawns `claude -p` as a child process with NDJSON streaming.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";
import { extractActivities, extractText, parseLine } from "./parser.js";
import type {
	AssistantMessage,
	ResultMessage,
	SessionActivity,
	SessionDoneStatus,
} from "./types.js";

const MAX_ACTIVITIES = 10;
const MAX_STDERR_LINES = 10;

export type SpawnOptions = {
	/** User's message text */
	prompt: string;
	/** System prompt (persona + memory) injected via --system-prompt */
	systemPrompt?: string;
	/** Resume an existing session instead of starting fresh */
	sessionId?: string;
	/** Claude model to use */
	model?: string;
	/** Maximum agentic turns */
	maxTurns?: number;
	/** Working directory for the claude process */
	cwd?: string;
	/** Skip permission prompts (dangerous — use only in trusted environments) */
	skipPermissions?: boolean;
};

export type SessionHandle = {
	readonly sessionId: string | undefined;
	/** Claude CLI session ID resolved from the result message. */
	claudeSessionId: string | undefined;
	readonly done: Promise<SessionDoneStatus>;
	readonly activities: SessionActivity[];
	readonly lastStderr: string[];
	currentActivity: SessionActivity | null;
	/** Register callback for streamed text chunks */
	onText(cb: (text: string) => void): void;
	/** Register callback for final result */
	onResult(cb: (result: ResultMessage) => void): void;
	/** Send SIGTERM */
	kill(): void;
	/** Send SIGKILL (after grace period) */
	forceKill(): void;
	/** Write data to child stdin */
	writeStdin(data: string): void;
};

export function spawnClaude(opts: SpawnOptions): SessionHandle {
	const { args, tmpFile } = buildArgs(opts);

	logger.debug("Spawning claude", { args: args.join(" ") });

	const child: ChildProcess = spawn("claude", args, {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	// Clean up temp system prompt file after process exits
	if (tmpFile) {
		child.on("close", () => {
			try {
				unlinkSync(tmpFile);
			} catch {}
		});
	}

	logger.debug("Claude process started", { pid: child.pid });

	const activities: SessionActivity[] = [];
	let currentActivity: SessionActivity | null = null;
	let resolvedClaudeSessionId: string | undefined;
	const lastStderr: string[] = [];
	let sigkillSent = false;

	const textCallbacks: Array<(text: string) => void> = [];
	const resultCallbacks: Array<(result: ResultMessage) => void> = [];

	// Buffer stderr for diagnostics (ring buffer)
	if (child.stderr) {
		const stderrRl = createInterface({ input: child.stderr });
		stderrRl.on("line", (line) => {
			if (lastStderr.length >= MAX_STDERR_LINES) {
				lastStderr.shift();
			}
			lastStderr.push(line);
		});
	}

	// Parse NDJSON from stdout
	if (child.stdout) {
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const msg = parseLine(line);
			if (!msg) return;

			// Track activities
			for (const activity of extractActivities(msg)) {
				if (activities.length >= MAX_ACTIVITIES) {
					activities.shift();
				}
				activities.push(activity);
				currentActivity = activity;
			}

			// Dispatch to callbacks
			if (msg.type === "assistant") {
				const text = extractText(msg as AssistantMessage);
				if (text) {
					for (const cb of textCallbacks) cb(text);
				}
			} else if (msg.type === "result") {
				const result = msg as ResultMessage;
				resolvedClaudeSessionId = result.session_id;
				for (const cb of resultCallbacks) cb(result);
			}
		});
	}

	const done = new Promise<SessionDoneStatus>((resolve) => {
		child.on("close", (code, signal) => {
			if (signal === "SIGTERM" || signal === "SIGINT") {
				logger.debug("Claude process interrupted", { pid: child.pid, signal });
				resolve("interrupted");
			} else if (code === 0) {
				logger.debug("Claude process completed", { pid: child.pid });
				resolve("completed");
			} else {
				logger.warn("Claude process failed", { pid: child.pid, code });
				resolve("failed");
			}
		});

		child.on("error", (err) => {
			logger.error("Claude process spawn error", { error: err.message });
			resolve("failed");
		});
	});

	return {
		sessionId: opts.sessionId,
		get claudeSessionId() {
			return resolvedClaudeSessionId;
		},
		set claudeSessionId(_: string | undefined) {
			// read-only externally
		},
		done,
		activities,
		lastStderr,
		get currentActivity() {
			return currentActivity;
		},
		set currentActivity(_) {
			// read-only externally, settable internally via closure
		},
		onText(cb) {
			textCallbacks.push(cb);
		},
		onResult(cb) {
			resultCallbacks.push(cb);
		},
		kill() {
			if (!child.killed) {
				logger.debug("Sending SIGTERM to claude", { pid: child.pid });
				child.kill("SIGTERM");
			}
		},
		forceKill() {
			if (!sigkillSent && child.pid) {
				sigkillSent = true;
				logger.debug("Sending SIGKILL to claude", { pid: child.pid });
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

function buildArgs(opts: SpawnOptions): {
	args: string[];
	tmpFile: string | null;
} {
	const args: string[] = [
		"-p",
		opts.prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		...(opts.skipPermissions ? ["--dangerously-skip-permissions"] : []),
	];

	if (opts.model) {
		args.push("--model", opts.model);
	}

	if (opts.maxTurns) {
		args.push("--max-turns", String(opts.maxTurns));
	}

	let tmpFile: string | null = null;
	if (opts.systemPrompt) {
		const tmpDir = resolve("data", "state", "tmp");
		mkdirSync(tmpDir, { recursive: true });
		tmpFile = join(tmpDir, `sysprompt-${randomUUID()}.md`);
		writeFileSync(tmpFile, opts.systemPrompt, "utf8");
		args.push("--system-prompt-file", tmpFile);
	}

	return { args, tmpFile };
}
