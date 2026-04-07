/**
 * Crash-recovery pointer.
 * Reference: Claude-code bridge/bridgePointer.ts
 *
 * Written on startup, periodically refreshed (mtime bump),
 * cleared on clean shutdown. If process dies unclean, pointer
 * persists and can be detected on next startup for session recovery.
 */

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const POINTER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const DaemonPointerSchema = z.object({
	activeSessions: z.array(
		z.object({
			sessionKey: z.string(),
			claudeSessionId: z.string().optional(),
			channelId: z.string(),
			userId: z.string(),
		}),
	),
	startedAt: z.number(),
	pid: z.number(),
});

export type DaemonPointer = z.infer<typeof DaemonPointerSchema>;

export class PointerManager {
	constructor(private readonly pointerPath: string) {}

	/** Write or refresh the pointer. Same content = mtime bump only. */
	async write(pointer: DaemonPointer): Promise<void> {
		try {
			await mkdir(dirname(this.pointerPath), { recursive: true });
			await writeFile(this.pointerPath, JSON.stringify(pointer, null, 2), "utf8");
			logger.debug("Pointer written");
		} catch (err) {
			logger.warn("Pointer write failed", { error: String(err) });
		}
	}

	/**
	 * Read the pointer if it exists and is fresh.
	 * Returns null if missing, corrupted, or stale (>4h).
	 * Stale pointers are auto-deleted.
	 */
	async read(): Promise<DaemonPointer | null> {
		let raw: string;
		let mtimeMs: number;

		try {
			mtimeMs = (await stat(this.pointerPath)).mtimeMs;
			raw = await readFile(this.pointerPath, "utf8");
		} catch {
			return null;
		}

		// Schema validation
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			logger.warn("Pointer corrupted, clearing");
			await this.clear();
			return null;
		}

		const result = DaemonPointerSchema.safeParse(parsed);
		if (!result.success) {
			logger.warn("Pointer schema invalid, clearing");
			await this.clear();
			return null;
		}

		// Staleness check
		const ageMs = Date.now() - mtimeMs;
		if (ageMs > POINTER_TTL_MS) {
			logger.info("Pointer stale (>4h), clearing");
			await this.clear();
			return null;
		}

		return result.data;
	}

	/** Clear the pointer on clean shutdown. */
	async clear(): Promise<void> {
		try {
			await unlink(this.pointerPath);
			logger.debug("Pointer cleared");
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("Pointer clear failed", { error: String(err) });
			}
		}
	}
}
