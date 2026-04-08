/**
 * Session lifecycle manager.
 * Reference: Claude-code bridge/bridgeMain.ts activeSessions Map + onSessionDone
 *
 * Manages concurrent LLM executor sessions per user+channel,
 * with timeout, cleanup, and graceful shutdown.
 */

import {
	spawnClaude,
} from "../executor/spawner.js";
import type {
	ExecutorFactory,
	ExecutorHandle,
	ExecutorSpawnOptions,
} from "../executor/interface.js";
import { logger } from "../utils/logger.js";
import { type SessionRecord, SessionStore } from "./store.js";

export type SessionManagerConfig = {
	maxConcurrentSessions: number;
	sessionTimeoutMs: number;
	/** Preferred model name (backend-agnostic). */
	model?: string;
	/** Legacy compatibility field. */
	claudeModel?: string;
	maxTurns: number;
	skipPermissions: boolean;
	storeDir: string;
	workspacePath?: string;
};

export type OnSessionTextCallback = (sessionKey: string, text: string) => void;
export type OnSessionDoneCallback = (
	sessionKey: string,
	status: "completed" | "failed" | "interrupted",
) => void;

export class SessionManager {
	private readonly activeSessions = new Map<string, ExecutorHandle>();
	private readonly sessionTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly store: SessionStore;
	private onTextCallback: OnSessionTextCallback | null = null;
	private onDoneCallback: OnSessionDoneCallback | null = null;

	constructor(
		private readonly config: SessionManagerConfig,
		private readonly spawn: ExecutorFactory = spawnClaude,
	) {
		this.store = new SessionStore(config.storeDir);
	}

	/** Build session key from user + channel. */
	static sessionKey(userId: string, channelId: string): string {
		return `${userId}:${channelId}`;
	}

	/** Check if a session is currently active. */
	isActive(sessionKey: string): boolean {
		return this.activeSessions.has(sessionKey);
	}

	get activeCount(): number {
		return this.activeSessions.size;
	}

	/** Register callback for streamed text from any session. */
	onText(cb: OnSessionTextCallback): void {
		this.onTextCallback = cb;
	}

	/** Register callback for session completion. */
	onDone(cb: OnSessionDoneCallback): void {
		this.onDoneCallback = cb;
	}

	/**
	 * Spawn a new session for every message.
	 * Returns null only when at global capacity.
	 */
	async getOrCreate(
		userId: string,
		channelId: string,
		prompt: string,
		systemPrompt?: string,
		model?: string,
	): Promise<ExecutorHandle | null> {
		const key = SessionManager.sessionKey(userId, channelId);

		// Capacity check — global across all users
		if (this.activeSessions.size >= this.config.maxConcurrentSessions) {
			logger.warn("At session capacity", {
				active: this.activeSessions.size,
				max: this.config.maxConcurrentSessions,
			});
			return null;
		}

		const record = await this.store.read(key);
		const spawnOpts: ExecutorSpawnOptions = {
			prompt,
			systemPrompt,
			model: model ?? this.resolveModel(),
			maxTurns: this.config.maxTurns,
			cwd: this.config.workspacePath,
			skipPermissions: this.config.skipPermissions,
		};

		const handle = this.spawn(spawnOpts);

		// Use unique session key per spawn to allow concurrent sessions per user
		const sessionKey = `${key}:${Date.now()}`;

		// Wire up text callback
		handle.onText((text) => {
			this.onTextCallback?.(sessionKey, text);
		});

		// Track session
		this.activeSessions.set(sessionKey, handle);
		this.scheduleTimeout(sessionKey);

		// Persist session record
		const now = Date.now();
		const newRecord: SessionRecord = {
			sessionId: key,
			userId,
			channelId,
			claudeSessionId: record?.claudeSessionId,
			createdAt: record?.createdAt ?? now,
			lastActivityAt: now,
			messageCount: (record?.messageCount ?? 0) + 1,
		};
		await this.store.write(key, newRecord);

		// Handle session completion
		void handle.done.then((status) =>
			this.handleSessionDone(sessionKey, status),
		);

		logger.info("Session started", {
			key: sessionKey,
			active: this.activeSessions.size,
		});

		return handle;
	}

	/** Graceful shutdown: kill all active sessions. */
	async shutdown(): Promise<void> {
		logger.info("Shutting down sessions", { active: this.activeSessions.size });

		// Clear all timers
		for (const timer of this.sessionTimers.values()) {
			clearTimeout(timer);
		}
		this.sessionTimers.clear();

		// SIGTERM all active sessions
		for (const handle of this.activeSessions.values()) {
			handle.kill();
		}

		// Wait for all to finish (with 30s grace)
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
		const allDone = Promise.all(
			[...this.activeSessions.values()].map((h) => h.done),
		).then(() => {});

		await Promise.race([allDone, timeout]);

		// Force kill any remaining
		for (const handle of this.activeSessions.values()) {
			handle.forceKill();
		}

		this.activeSessions.clear();
		logger.info("All sessions shut down");
	}

	/** Get all active session keys for crash recovery pointer. */
	getActiveSessionKeys(): string[] {
		return [...this.activeSessions.keys()];
	}

	/** Get snapshots of all active sessions for status sharing. */
	getSessionSnapshots(): Array<{
		userId: string;
		channelId: string;
		currentActivity: {
			type: string;
			summary: string;
			timestamp: number;
		} | null;
		startedAt: number;
	}> {
		return [...this.activeSessions.entries()].map(([key, handle]) => {
			const parts = key.split(":");
			return {
				userId: parts[0] ?? "",
				channelId: parts[1] ?? "",
				currentActivity: handle.currentActivity,
				startedAt: Number(parts[2]) || Date.now(),
			};
		});
	}

	private handleSessionDone(
		sessionKey: string,
		status: "completed" | "failed" | "interrupted",
	): void {
		const handle = this.activeSessions.get(sessionKey);

		// Extract base key (userId:channelId) from timestamped sessionKey
		const parts = sessionKey.split(":");
		const baseKey = parts.length >= 3 ? `${parts[0]}:${parts[1]}` : sessionKey;

		// Persist claude session ID for future reference
		const resolvedSessionId = handle?.sessionId ?? handle?.claudeSessionId;
		if (resolvedSessionId) {
			void this.store.read(baseKey).then((record) => {
				if (record) {
					void this.store.write(baseKey, {
						...record,
						claudeSessionId: resolvedSessionId,
						lastActivityAt: Date.now(),
					});
				}
			});
		}

		this.activeSessions.delete(sessionKey);

		const timer = this.sessionTimers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			this.sessionTimers.delete(sessionKey);
		}

		logger.info("Session ended", { key: sessionKey, status });
		this.onDoneCallback?.(sessionKey, status);
	}

	private scheduleTimeout(key: string): void {
		this.clearTimeout(key);

		const timer = setTimeout(() => {
			const handle = this.activeSessions.get(key);
			if (handle) {
				logger.info("Session timed out", {
					key,
					timeoutMs: this.config.sessionTimeoutMs,
				});
				handle.kill();
				// Force kill after 30s grace period
				setTimeout(() => handle.forceKill(), 30_000);
			}
		}, this.config.sessionTimeoutMs);

		this.sessionTimers.set(key, timer);
	}

	private clearTimeout(key: string): void {
		const timer = this.sessionTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.sessionTimers.delete(key);
		}
	}

	private resolveModel(): string {
		return this.config.model ?? this.config.claudeModel ?? "sonnet";
	}
}
