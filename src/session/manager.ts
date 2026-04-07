/**
 * Session lifecycle manager.
 * Reference: Claude-code bridge/bridgeMain.ts activeSessions Map + onSessionDone
 *
 * Manages concurrent Claude CLI sessions per user+channel,
 * with timeout, cleanup, and graceful shutdown.
 */

import {
	type SessionHandle,
	type SpawnOptions,
	spawnClaude,
} from "../executor/spawner.js";
import { logger } from "../utils/logger.js";
import { type SessionRecord, SessionStore } from "./store.js";

export type SessionManagerConfig = {
	maxConcurrentSessions: number;
	sessionTimeoutMs: number;
	claudeModel: string;
	maxTurns: number;
	storeDir: string;
	workspacePath?: string;
};

export type OnSessionTextCallback = (sessionKey: string, text: string) => void;
export type OnSessionDoneCallback = (
	sessionKey: string,
	status: "completed" | "failed" | "interrupted",
) => void;

export class SessionManager {
	private readonly activeSessions = new Map<string, SessionHandle>();
	private readonly sessionTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly store: SessionStore;
	private onTextCallback: OnSessionTextCallback | null = null;
	private onDoneCallback: OnSessionDoneCallback | null = null;

	constructor(private readonly config: SessionManagerConfig) {
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
	 * Spawn a new claude session for every message.
	 * Returns null only when at global capacity.
	 */
	async getOrCreate(
		userId: string,
		channelId: string,
		prompt: string,
		systemPrompt?: string,
	): Promise<SessionHandle | null> {
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
		const spawnOpts: SpawnOptions = {
			prompt,
			systemPrompt,
			model: this.config.claudeModel,
			maxTurns: this.config.maxTurns,
			cwd: this.config.workspacePath,
		};

		const handle = spawnClaude(spawnOpts);

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

	private handleSessionDone(
		key: string,
		status: "completed" | "failed" | "interrupted",
	): void {
		const handle = this.activeSessions.get(key);

		// Persist claude session ID for future resume
		if (handle?.claudeSessionId) {
			void this.store.read(key).then((record) => {
				if (record) {
					void this.store.write(key, {
						...record,
						claudeSessionId: handle.claudeSessionId,
						lastActivityAt: Date.now(),
					});
				}
			});
		}

		this.activeSessions.delete(key);

		const timer = this.sessionTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.sessionTimers.delete(key);
		}

		logger.info("Session ended", { key, status });
		this.onDoneCallback?.(key, status);
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
}
