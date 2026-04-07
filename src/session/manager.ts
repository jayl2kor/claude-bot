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
	storeDir: string;
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
	 * Get existing session or create a new one.
	 * If at capacity, returns null.
	 */
	async getOrCreate(
		userId: string,
		channelId: string,
		prompt: string,
		systemPrompt?: string,
	): Promise<SessionHandle | null> {
		const key = SessionManager.sessionKey(userId, channelId);

		// Reuse active session — write prompt to stdin
		const existing = this.activeSessions.get(key);
		if (existing) {
			this.resetTimeout(key);
			return existing;
		}

		// Capacity check
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
			maxTurns: 1,
		};

		const handle = spawnClaude(spawnOpts);

		// Wire up text callback
		handle.onText((text) => {
			this.onTextCallback?.(key, text);
		});

		// Track session
		this.activeSessions.set(key, handle);
		this.scheduleTimeout(key);

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
		void handle.done.then((status) => this.handleSessionDone(key, status));

		logger.info("Session started", {
			key,
			resumed: !!record?.claudeSessionId,
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

	private resetTimeout(key: string): void {
		this.scheduleTimeout(key);
	}

	private clearTimeout(key: string): void {
		const timer = this.sessionTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.sessionTimers.delete(key);
		}
	}
}
