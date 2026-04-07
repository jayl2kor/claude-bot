/**
 * Status writer — publishes this pet's current state to the shared directory.
 * Other pets read this to know what we're doing.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionManager } from "../session/manager.js";
import { logger } from "../utils/logger.js";
import type { PetStatus } from "./types.js";

export class StatusWriter {
	private readonly filePath: string;
	private readonly startedAt = Date.now();

	constructor(
		sharedDir: string,
		private readonly petId: string,
		private readonly personaName: string,
		private readonly sessionManager: SessionManager,
	) {
		this.filePath = join(sharedDir, `${petId}.json`);
	}

	/** Write current status to shared file. */
	async write(): Promise<void> {
		const snapshots = this.sessionManager.getSessionSnapshots();

		const status: PetStatus = {
			petId: this.petId,
			personaName: this.personaName,
			activeSessionCount: snapshots.length,
			sessions: snapshots.map((s) => ({
				userId: s.userId,
				channelId: s.channelId,
				currentActivity: s.currentActivity,
				startedAt: s.startedAt,
			})),
			heartbeatAt: Date.now(),
			startedAt: this.startedAt,
		};

		try {
			const tmp = `${this.filePath}.${randomUUID()}.tmp`;
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(tmp, JSON.stringify(status, null, 2), "utf8");
			await rename(tmp, this.filePath);
		} catch (err) {
			logger.warn("Status write failed", { error: String(err) });
		}
	}

	/** Clear status on clean shutdown. */
	async clear(): Promise<void> {
		try {
			await unlink(this.filePath);
			logger.debug("Status file cleared");
		} catch {
			// Already gone
		}
	}
}
