/**
 * Single-instance process lock using PID file.
 * Prevents duplicate daemon instances.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export class ProcessLock {
	constructor(private readonly lockPath: string) {}

	/** Acquire the lock. Throws if another instance is running. */
	async acquire(): Promise<void> {
		// Check for existing lock
		try {
			const raw = await readFile(this.lockPath, "utf8");
			const existingPid = Number.parseInt(raw.trim(), 10);

			if (Number.isNaN(existingPid)) {
				// Corrupted lock file — remove and proceed
				await this.release();
			} else if (isProcessAlive(existingPid)) {
				throw new Error(
					`Another claude-pet instance is running (PID ${existingPid}). ` +
						`Remove ${this.lockPath} if this is incorrect.`,
				);
			} else {
				// Stale lock from dead process
				logger.info("Removing stale lock file", { stalePid: existingPid });
				await this.release();
			}
		} catch (err) {
			if (!isENOENT(err)) throw err;
		}

		await mkdir(dirname(this.lockPath), { recursive: true });
		await writeFile(this.lockPath, String(process.pid), "utf8");
		logger.debug("Process lock acquired", { pid: process.pid });
	}

	/** Release the lock. */
	async release(): Promise<void> {
		try {
			await unlink(this.lockPath);
			logger.debug("Process lock released");
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("Failed to release lock", { error: String(err) });
			}
		}
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // Signal 0 = existence check only
		return true;
	} catch {
		return false;
	}
}
