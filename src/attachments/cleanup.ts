/**
 * Upload cleanup — removes date-based upload directories older than
 * the configured retention period.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const DATE_DIR_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Remove date directories in `uploadDir` that are older than `retentionDays`.
 *
 * @returns Number of directories removed.
 */
export async function cleanOldUploads(
	uploadDir: string,
	retentionDays: number,
): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(uploadDir);
	} catch (err) {
		if (isENOENT(err)) return 0;
		throw err;
	}

	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);
	cutoff.setHours(0, 0, 0, 0);

	let removed = 0;

	for (const entry of entries) {
		// Only process date-formatted directory names
		if (!DATE_DIR_REGEX.test(entry)) continue;

		const fullPath = join(uploadDir, entry);

		// Verify it's actually a directory
		try {
			const info = await stat(fullPath);
			if (!info.isDirectory()) continue;
		} catch {
			continue;
		}

		// Parse the date from the directory name
		const dirDate = new Date(`${entry}T00:00:00`);
		if (Number.isNaN(dirDate.getTime())) continue;

		if (dirDate < cutoff) {
			try {
				await rm(fullPath, { recursive: true, force: true });
				removed++;
				logger.debug("Removed old upload directory", { path: fullPath });
			} catch (err) {
				logger.warn("Failed to remove upload directory", {
					path: fullPath,
					error: String(err),
				});
			}
		}
	}

	return removed;
}
