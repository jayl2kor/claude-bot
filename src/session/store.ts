/**
 * Atomic file-based session store with per-key write locking.
 * Reference: OpenClaw src/config/sessions/store.ts
 *
 * Uses temp file + rename for atomic writes, and a per-key lock
 * queue to prevent concurrent modification of the same session.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export type SessionRecord = {
	sessionId: string;
	userId: string;
	channelId: string;
	claudeSessionId: string | undefined;
	createdAt: number;
	lastActivityAt: number;
	messageCount: number;
};

export class SessionStore {
	private readonly locks = new Map<string, Promise<void>>();

	constructor(private readonly baseDir: string) {}

	async read(key: string): Promise<SessionRecord | null> {
		try {
			const raw = await readFile(this.filePath(key), "utf8");
			return JSON.parse(raw) as SessionRecord;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("Failed to read session", { key, error: String(err) });
			return null;
		}
	}

	async write(key: string, record: SessionRecord): Promise<void> {
		await this.withLock(key, async () => {
			await this.atomicWrite(key, record);
		});
	}

	async delete(key: string): Promise<void> {
		await this.withLock(key, async () => {
			try {
				await unlink(this.filePath(key));
			} catch (err) {
				if (!isENOENT(err)) throw err;
			}
		});
	}

	async list(): Promise<string[]> {
		const { readdir } = await import("node:fs/promises");
		try {
			const files = await readdir(this.baseDir);
			return files
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.replace(".json", ""));
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}
	}

	private filePath(key: string): string {
		// Sanitize key for filesystem safety
		const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.baseDir, `${safe}.json`);
	}

	/** Atomic write: write to temp file, then rename. */
	private async atomicWrite(key: string, data: SessionRecord): Promise<void> {
		const target = this.filePath(key);
		const tmp = `${target}.${randomUUID()}.tmp`;

		await mkdir(dirname(target), { recursive: true });
		await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
		await rename(tmp, target);
	}

	/** Per-key lock queue to serialize writes to the same session. */
	private async withLock(key: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.locks.get(key) ?? Promise.resolve();

		const current = prev.then(fn, fn); // Run fn after previous completes
		this.locks.set(key, current);

		try {
			await current;
		} finally {
			// Clean up if we're the last in the queue
			if (this.locks.get(key) === current) {
				this.locks.delete(key);
			}
		}
	}
}
